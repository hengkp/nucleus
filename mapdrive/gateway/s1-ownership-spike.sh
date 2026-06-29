#!/usr/bin/env bash
# s1-ownership-spike.sh — PHASE-0 GATE S1 (RISKS #1, BUILD_PLAN Phase 0).
# The single make-or-break test for the whole CIFS-gateway premise: does a file written as
# a real LDAP uid through the gateway preserve that numeric owner end-to-end (NOT collapse
# to nobody:nobody), and do user.* xattrs survive the NFS round-trip?
#
# Run as root ON THE GATEWAY NODE after the NAS export is mounted at $MOUNT. It writes only
# into a scratch subdir and cleans up. Re-run on node1-4 with --stat-only to confirm other
# nodes see the same owner.
#
#   sudo ./s1-ownership-spike.sh --uid 10012 --gid 100000
#   sudo ./s1-ownership-spike.sh --stat-only --uid 10012   # on another node, after a write
set -Eeuo pipefail

MOUNT="${MOUNT:-/srv/nas/sisplockers}"
SCRATCH="${SCRATCH:-$MOUNT/.s1-spike}"
TEST_UID=10012
TEST_GID=100000
STAT_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uid) TEST_UID="${2:?}"; shift 2;;
    --gid) TEST_GID="${2:?}"; shift 2;;
    --mount) MOUNT="${2:?}"; SCRATCH="$MOUNT/.s1-spike"; shift 2;;
    --stat-only) STAT_ONLY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 64;;
  esac
done

pass=0; fail=0; warn=0
ok()   { echo "  PASS: $*"; pass=$((pass+1)); }
no()   { echo "  FAIL: $*"; fail=$((fail+1)); }
warn() { echo "  WARN: $*"; warn=$((warn+1)); }

echo "S1 ownership spike — mount=$MOUNT uid=$TEST_UID gid=$TEST_GID stat_only=$STAT_ONLY"
mountpoint -q "$MOUNT" && ok "export is mounted at $MOUNT" || no "nothing mounted at $MOUNT (mount the NAS export first)"

F="$SCRATCH/owner-probe.$TEST_UID"
X="$SCRATCH/xattr-probe.$TEST_UID"

if [[ $STAT_ONLY -eq 0 ]]; then
  [[ $EUID -eq 0 ]] || { echo "must run as root to write as a uid" >&2; exit 1; }
  mkdir -p "$SCRATCH"
  # Write a file AS the test uid:gid (mimics what smbd does for that user).
  install -o "$TEST_UID" -g "$TEST_GID" -m 0600 /dev/null "$F"
  echo "spike $(date -u +%FT%TZ)" >>"$F"
  # xattr round-trip.
  if setfattr -n user.s1test -v "ok-$TEST_UID" "$X" 2>/dev/null || { : >"$X" && setfattr -n user.s1test -v "ok-$TEST_UID" "$X"; }; then
    ok "setfattr user.* accepted"
  else
    warn "setfattr user.* rejected — use the reduced vfs_fruit stack (fruit:metadata=netatalk), RISKS #20. NOT a gate."
  fi
fi

# The critical assertion: owner is the numeric uid, NOT 65534/nobody.
if [[ -e "$F" ]]; then
  owner="$(stat -c '%u:%g' "$F")"
  if [[ "$owner" == "$TEST_UID:$TEST_GID" ]]; then
    ok "owner preserved end-to-end: $owner"
  else
    no "OWNER NOT PRESERVED: got '$owner', expected '$TEST_UID:$TEST_GID' (NFSv4 idmap -> nobody? set nfs4_disable_idmapping=Y or use NFSv3 AUTH_SYS — the gateway premise is blocked until this passes)"
  fi
else
  no "probe file missing at $F (run a write pass on the gateway first, then --stat-only here)"
fi

if [[ -e "$X" ]]; then
  if getfattr -n user.s1test --only-values "$X" 2>/dev/null | grep -q "ok-$TEST_UID"; then
    ok "xattr survived the round-trip"
  else
    warn "xattr did not survive — macOS Finder metadata uses netatalk sidecars instead (reduced fruit stack). NOT a gate."
  fi
fi

# Cleanup only on the writing node.
if [[ $STAT_ONLY -eq 0 ]]; then rm -rf "$SCRATCH"; fi

echo
echo "S1: $pass passed, $fail failed, $warn warnings"
if [[ $fail -gt 0 ]]; then
  echo "GATE S1 = RED — ownership/mount premise failed. Do not proceed to Phase 2. See messages above."
  exit 1
fi
if [[ $warn -gt 0 ]]; then
  echo "GATE S1 = GREEN (with warnings) — numeric ownership holds; xattr unsupported, so use the"
  echo "reduced vfs_fruit (netatalk) stack in smb.conf. Safe to build the gateway."
else
  echo "GATE S1 = GREEN — numeric ownership + xattr round-trip hold. Safe to build the gateway."
fi
