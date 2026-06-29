#!/usr/bin/env bash
# provision-lockers.sh — pre-create per-user lockers with CORRECT LDAP ownership.
# Run as root ON THE GATEWAY NODE, against the firewalled no_root_squash NFS export
# (ADR-004). Idempotent: safe to re-run. Does NOT touch file contents — only creates
# missing dirs and fixes ownership/mode of the locker roots.
#
#   sudo ./provision-lockers.sh            # provision all LDAP researchers
#   sudo ./provision-lockers.sh --dry-run  # show what would change
#   sudo ./provision-lockers.sh --user kriengkraip
set -Eeuo pipefail

LOCKERS_ROOT="${LOCKERS_ROOT:-/srv/nas/sisplockers}"
UID_FLOOR="${UID_FLOOR:-10000}"
PRIMARY_GID="${PRIMARY_GID:-100000}"
DRY_RUN=0
ONE_USER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift;;
    --user) ONE_USER="${2:-}"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 64;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "must run as root (chown requires it)" >&2; exit 1; }
[[ -d "$LOCKERS_ROOT" ]] || { echo "lockers root not mounted: $LOCKERS_ROOT" >&2; exit 1; }

act() { if [[ $DRY_RUN -eq 1 ]]; then echo "DRY: $*"; else "$@"; fi; }

provision_one() {
  local user="$1" pw uidn gidn dir
  pw="$(getent passwd "$user")" || { echo "skip (no such user): $user"; return; }
  uidn="$(cut -d: -f3 <<<"$pw")"; gidn="$(cut -d: -f4 <<<"$pw")"
  # Only real LDAP researchers.
  (( uidn >= UID_FLOOR )) || { echo "skip (uid<$UID_FLOOR): $user ($uidn)"; return; }
  (( gidn == PRIMARY_GID )) || { echo "WARN skip (gid!=$PRIMARY_GID): $user ($gidn)"; return; }

  dir="$LOCKERS_ROOT/$user"
  if [[ ! -d "$dir" ]]; then act mkdir -p "$dir"; fi

  # Fix ownership of the locker ROOT only (not recursive — don't rewrite user content).
  local cur_owner; cur_owner="$(stat -c '%u:%g' "$dir" 2>/dev/null || echo '?')"
  if [[ "$cur_owner" != "$uidn:$gidn" ]]; then
    echo "fix owner $dir: $cur_owner -> $uidn:$gidn"
    act chown "$uidn:$gidn" "$dir"
  fi
  local cur_mode; cur_mode="$(stat -c '%a' "$dir" 2>/dev/null || echo '?')"
  if [[ "$cur_mode" != "700" ]]; then
    echo "fix mode  $dir: $cur_mode -> 700"
    act chmod 0700 "$dir"
  fi
}

if [[ -n "$ONE_USER" ]]; then
  provision_one "$ONE_USER"
else
  # All posixAccount users in the directory.
  getent passwd | awk -F: -v f="$UID_FLOOR" -v g="$PRIMARY_GID" '$3>=f && $4==g {print $1}' | while read -r u; do
    provision_one "$u"
  done
fi

echo "done${DRY_RUN:+ (dry-run)}."
