#!/usr/bin/env bash
# reconcile-identity.sh — fix the broken LDAP migration safely and REVERSIBLY.
# (Root cause from docs/IDENTITY_AUDIT.md: local /etc/passwd accounts shadow LDAP, and lockers
#  are owned by a mix of legacy/generic uids.)
#
# What it does, per LDAP user's locker:
#   - resolves the CANONICAL uid from LDAP directly (NOT getent, which returns local shadows),
#   - if the locker is owned by the wrong uid: chown -R --from=<old> <ldap-uid>:<gid> (precise,
#     only touches files currently owned by <old>),
#   - chmod 0700 the locker root,
#   - provisions a 0700 locker for LDAP users who have none.
# It does NOT touch orphan/shared dirs (not named after an LDAP user), and it does NOT delete
# local accounts — it EMITS a reviewable remove-shadows script for the admin.
#
# Dry-run by default. --apply writes a journal AND a rollback script that reverses every change.
#
#   sudo ./reconcile-identity.sh                 # preview (no changes)
#   sudo ./reconcile-identity.sh --apply         # apply + write journal + rollback script
#   sudo bash /var/log/apphub/identity-rollback-<ts>.sh   # full rollback
set -Eeuo pipefail
IFS=$'\n\t'

APPLY=0
LOCKERS="${LOCKERS:-/mnt/sisplockers}"
LDAP_URI="${LDAP_URI:-ldap://127.0.0.1}"
BASE="${BASE:-dc=siriraj,dc=local}"
GID="${GID:-100000}"
UID_FLOOR=10000
JDIR="${JDIR:-/var/log/apphub}"
PROVISION=1
NEW_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift;;
    --lockers) LOCKERS="$2"; shift 2;;
    --ldap-uri) LDAP_URI="$2"; shift 2;;
    --base) BASE="$2"; shift 2;;
    --journal-dir) JDIR="$2"; shift 2;;
    --no-provision) PROVISION=0; shift;;
    # Only CREATE missing lockers; never touch existing lockers (no chown/chmod) or shadows.
    # Safe to run while the cluster is busy — purely additive, no access reduction.
    --new-only) NEW_ONLY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 64;;
  esac
done

die() { echo "reconcile: $*" >&2; exit 1; }
command -v ldapsearch >/dev/null || die "ldapsearch not found"
[[ -d "$LOCKERS" ]] || die "lockers root not mounted: $LOCKERS"
if [[ $APPLY -eq 1 ]]; then
  [[ $EUID -eq 0 ]] || die "must run as root for --apply"
  command -v chown >/dev/null && chown --help 2>&1 | grep -q -- '--from' || die "GNU chown with --from required"
fi

ts="$(date +%Y%m%d-%H%M%S)"
journal="$JDIR/identity-reconcile-$ts.journal"
rollback="$JDIR/identity-rollback-$ts.sh"
shadows="$JDIR/remove-shadows-$ts.sh"
mode="DRY-RUN"; [[ $APPLY -eq 1 ]] && mode="APPLY"

if [[ $APPLY -eq 1 ]]; then
  mkdir -p "$JDIR"
  : > "$journal"
  { echo "#!/usr/bin/env bash"; echo "# Rollback for identity-reconcile-$ts. Run as root."; echo "set -Eeuo pipefail"; } > "$rollback"
  { echo "#!/usr/bin/env bash"; echo "# REVIEW before running. Removes local /etc/passwd accounts that shadow LDAP."; echo "# Homes live on the NAS and are kept (--no-remove-home). Ensure no live procs own these uids."; echo "set -e"; } > "$shadows"
fi

# NOTE: log/rbk must `return 0` — a function ending in a false `&&` conditional returns
# non-zero, which would trip `set -e` at the call site (dry-run gotcha).
log()   { echo "$*"; [[ $APPLY -eq 1 ]] && echo "$*" >> "$journal"; return 0; }
runcmd(){ if [[ $APPLY -eq 1 ]]; then "$@"; else echo "    would: $*"; fi; }
rbk()   { [[ $APPLY -eq 1 ]] && echo "$*" >> "$rollback"; return 0; }

# --- canonical uid map from LDAP (authoritative) -----------------------------
declare -A LDAPUID
while IFS=: read -r u n; do [[ -n "$u" && -n "$n" ]] && LDAPUID["$u"]="$n"; done < <(
  ldapsearch -x -LLL -H "$LDAP_URI" -b "$BASE" "(objectClass=posixAccount)" uid uidNumber 2>/dev/null \
    | awk '/^uid: /{u=$2} /^uidNumber: /{print u":"$2}'
)
[[ ${#LDAPUID[@]} -gt 0 ]] || die "no LDAP posixAccounts found (check --ldap-uri/--base / bind policy)"
log "# identity reconcile ($mode) — $ts — ${#LDAPUID[@]} LDAP users, lockers=$LOCKERS"

n_chown=0; n_chmod=0; n_new=0; n_clean=0; n_shadow=0
for u in $(printf '%s\n' "${!LDAPUID[@]}" | sort); do
  newuid="${LDAPUID[$u]}"
  [[ "$newuid" =~ ^[0-9]+$ ]] || { log "SKIP $u: non-numeric LDAP uid"; continue; }
  (( newuid >= UID_FLOOR )) || { log "SKIP $u: LDAP uid $newuid < $UID_FLOOR (not a migrated account)"; continue; }
  dir="$LOCKERS/$u"

  if [[ ! -e "$dir" ]]; then
    if [[ $PROVISION -eq 1 ]]; then
      log "NEW   $u: create locker -> $newuid:$GID 0700"
      runcmd mkdir -p "$dir"; runcmd chown "$newuid:$GID" "$dir"; runcmd chmod 0700 "$dir"
      rbk "[ -d '$dir' ] && rmdir --ignore-fail-on-non-empty '$dir' || true"
      n_new=$((n_new+1))
    fi
  elif [[ $NEW_ONLY -eq 1 ]]; then
    : # existing locker — skip entirely in --new-only mode (no access change)
  else
    # space-split explicitly: the global IFS has no space, which would merge the fields.
    IFS=' ' read -r olduid oldgid oldmode < <(stat -c '%u %g %a' "$dir")
    if [[ "$olduid" != "$newuid" ]]; then
      log "CHOWN $u: $dir  $olduid -> $newuid (recursive, --from=$olduid)"
      runcmd chown -R --from="$olduid" "$newuid:$GID" "$dir"
      rbk "chown -R --from='$newuid' '$olduid:$oldgid' '$dir'   # revert $u"
      n_chown=$((n_chown+1))
    fi
    if [[ "$oldmode" != "700" ]]; then
      log "CHMOD $u: $dir  $oldmode -> 700"
      runcmd chmod 0700 "$dir"
      rbk "chmod $oldmode '$dir'   # revert $u mode"
      n_chmod=$((n_chmod+1))
    fi
    [[ "$olduid" == "$newuid" && "$oldmode" == "700" ]] && n_clean=$((n_clean+1)) || true
  fi

  # shadow account? local /etc/passwd entry whose uid != LDAP uid. (skipped in --new-only)
  if [[ $NEW_ONLY -eq 0 ]] && locline="$(grep "^$u:" /etc/passwd 2>/dev/null)"; then
    localuid="$(cut -d: -f3 <<<"$locline")"
    if [[ "$localuid" != "$newuid" ]]; then
      log "SHADOW $u: local /etc/passwd uid=$localuid shadows LDAP uid=$newuid -> queued for removal"
      [[ $APPLY -eq 1 ]] && echo "deluser --no-remove-home '$u'   # local uid $localuid shadows LDAP $newuid" >> "$shadows"
      n_shadow=$((n_shadow+1))
    fi
  fi
done

echo
echo "SUMMARY ($mode): chown=$n_chown chmod=$n_chmod new-lockers=$n_new already-clean=$n_clean shadow-accounts=$n_shadow"
if [[ $APPLY -eq 1 ]]; then
  chmod +x "$rollback" "$shadows"
  echo "journal:        $journal"
  echo "rollback (run to fully revert data changes):  sudo bash $rollback"
  echo "shadow removals (REVIEW, then run separately): $shadows"
else
  echo "(dry-run — no changes. Re-run with --apply in a maintenance window.)"
  echo "NOTE: orphan/shared dirs (not LDAP usernames) are intentionally untouched."
fi
