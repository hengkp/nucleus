#!/usr/bin/env bash
# apphub-fileop.sh — per-user locker file operations. Invoked via a scoped sudoers rule.
# Every operation runs AS the requesting LDAP user (runuser), so the OS enforces the user's
# own rights on their (often 0700) locker — the backend never bypasses permissions. The
# operation always stays INSIDE the user's home/locker; no path traversal.
#
# Usage: apphub-fileop.sh --user U --op OP --path P [--path2 P2] [--sha SHA256]
#   list   --path P                 -> "type<TAB>size<TAB>mtime<TAB>name" per entry
#   stat   --path P                 -> "type<TAB>size<TAB>mtime"
#   mkdir  --path P                 -> create directory (parent must exist)
#   mkfile --path P                 -> create empty file (must not exist)
#   rename --path SRC --path2 DST   -> move/rename within the locker (no clobber)
#   delete --path P                 -> remove file or directory (recursive)
#   read   --path P                 -> stream file bytes to stdout (download)
#   write  --path P [--sha S]       -> stream stdin to file (upload); atomic; sha256 verified
#                                      -> prints "sha256<TAB>size" on success
#   hash   --path P                 -> prints sha256 of file
set -Eeuo pipefail

USER="" OP="" P1="" P2="" SHA="" SIZE="" ROOTPATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)     USER="${2:-}"; shift 2;;
    --op)       OP="${2:-}";   shift 2;;
    --path)     P1="${2:-}";   shift 2;;
    --path2)    P2="${2:-}";   shift 2;;
    --sha)      SHA="${2:-}";  shift 2;;
    --size)     SIZE="${2:-}"; shift 2;;
    --rootpath) ROOTPATH="${2:-}"; shift 2;;  # browse a SHARED NAS area (read-only) instead of the locker
    *) echo "bad arg" >&2; exit 64;;
  esac
done

# ---- validate user (defense in depth; the backend already checks) -------------
[[ "$USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "bad user" >&2; exit 64; }
case "$USER" in root|nodeadmin|admin|daemon|bin|sys|slurm|postgres|nobody) echo "reserved" >&2; exit 64;; esac
case "$OP" in list|stat|mkdir|mkfile|rename|delete|read|write|hash|dirsize|zipdir) ;; *) echo "bad op" >&2; exit 64;; esac

# ---- validate relative paths -------------------------------------------------
# The op runs AS the user (runuser) and is realpath-confined under the locker, so ordinary
# filename characters are allowed. Reject only a `..` path segment (traversal), a leading
# slash, and control chars (which would also corrupt the tab/newline-delimited list output).
valid_path() {
  local p="$1"
  case "/$p/" in */../*) return 1;; esac
  [[ "$p" != /* ]] || return 1
  [[ "$p" == *[[:cntrl:]]* ]] && return 1
  (( ${#p} <= 4096 )) || return 1
  return 0
}
valid_path "$P1" || { echo "bad path" >&2; exit 64; }
[[ -n "$P2" ]] && { valid_path "$P2" || { echo "bad path2" >&2; exit 64; }; }
if [[ "$OP" != "list" && "$OP" != "stat" ]]; then
  [[ -n "$P1" ]] || { echo "empty path" >&2; exit 64; }
fi
if [[ "$OP" == "rename" ]]; then
  [[ -n "$P2" ]] || { echo "rename needs --path2" >&2; exit 64; }
fi
if [[ -n "$SHA" ]]; then [[ "$SHA" =~ ^[a-f0-9]{64}$ ]] || { echo "bad sha" >&2; exit 64; }; fi
if [[ -n "$SIZE" ]]; then [[ "$SIZE" =~ ^[0-9]{1,19}$ ]] || { echo "bad size" >&2; exit 64; }; fi

PW="$(getent passwd "$USER")" || { echo "no user" >&2; exit 66; }
UID_N="$(cut -d: -f3 <<<"$PW")"; HOME_DIR="$(cut -d: -f6 <<<"$PW")"
(( UID_N >= 10000 )) || { echo "uid floor" >&2; exit 66; }

# Choose the confinement root: the user's locker (default, full read/write) OR a SHARED NAS area
# (read-only browse). The shared area is still accessed AS the user via runuser, so the OS enforces
# the user's real permissions on it (no copying, no privilege bypass) — this only adds discovery.
BASE_ROOT="$HOME_DIR"
if [[ -n "$ROOTPATH" ]]; then
  case "$OP" in list|stat|dirsize) ;; *) echo "op not allowed on a shared root (read-only)" >&2; exit 64;; esac
  [[ "$ROOTPATH" == /mnt/* && "$ROOTPATH" != *..* && "$ROOTPATH" != *[[:cntrl:]]* ]] || { echo "shared root must be under /mnt" >&2; exit 64; }
  RP="$(realpath -m -- "$ROOTPATH")"
  case "$RP" in /mnt/?*) ;; *) echo "shared root must be a folder under /mnt" >&2; exit 64;; esac
  [[ "$RP" == "/mnt" ]] && { echo "refuse to browse all of /mnt" >&2; exit 64; }
  BASE_ROOT="$RP"
fi

# Everything below runs AS the user. ROOT is the locker (or a shared NAS root); paths are confined under it.
exec runuser -u "$USER" -- bash -c '
set -Eeuo pipefail
op="$1"; ROOT="$2"; P1="$3"; P2="$4"; SHA="$5"; SIZE="$6"
ROOTRP="$(realpath -m -- "$ROOT")"

confined() { # echo absolute real path of $1-relative IF it stays under ROOT (parent must)
  local rel="$1" abs parent base rp
  if [ -z "$rel" ]; then printf "%s" "$ROOTRP"; return 0; fi
  abs="$ROOT/$rel"
  parent="$(dirname -- "$abs")"; base="$(basename -- "$abs")"
  rp="$(realpath -m -- "$parent")" || return 1
  case "$rp/" in "$ROOTRP"/*|"$ROOTRP/") ;; *) return 1;; esac
  printf "%s/%s" "$rp" "$base"
}

case "$op" in
  list)
    d="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -d "$d" ] || { echo "not a dir" >&2; exit 67; }
    shopt -s nullglob dotglob
    for e in "$d"/*; do
      b="$(basename -- "$e")"
      { [ "$b" = "." ] || [ "$b" = ".." ]; } && continue
      if [ -d "$e" ]; then t=dir; else t=file; fi
      printf "%s\t%s\t%s\t%s\n" "$t" "$(stat -c %s -- "$e" 2>/dev/null || echo 0)" "$(stat -c %Y -- "$e" 2>/dev/null || echo 0)" "$b"
    done
    ;;
  stat)
    t="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -e "$t" ] || { echo "no such path" >&2; exit 67; }
    if [ -d "$t" ]; then ty=dir; else ty=file; fi
    printf "%s\t%s\t%s\n" "$ty" "$(stat -c %s -- "$t" 2>/dev/null || echo 0)" "$(stat -c %Y -- "$t" 2>/dev/null || echo 0)"
    ;;
  dirsize)
    t="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -d "$t" ] || { echo "not a dir" >&2; exit 67; }
    # Apparent total bytes; bounded so a huge tree never stalls the listing.
    if out="$(timeout 6 du -sb -- "$t" 2>/dev/null | head -1 | cut -f1)" && [ -n "$out" ]; then echo "$out"; else echo -1; fi
    ;;
  mkdir)
    t="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -e "$t" ] && { echo "already exists" >&2; exit 73; }
    mkdir -- "$t"
    ;;
  mkfile)
    t="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -e "$t" ] && { echo "already exists" >&2; exit 73; }
    ( set -C; : > "$t" )
    ;;
  rename)
    s="$(confined "$P1")" || { echo "src out of locker" >&2; exit 64; }
    d="$(confined "$P2")" || { echo "dst out of locker" >&2; exit 64; }
    [ -e "$s" ] || { echo "source missing" >&2; exit 67; }
    [ -e "$d" ] && { echo "destination exists" >&2; exit 73; }
    mv -n -- "$s" "$d"
    ;;
  delete)
    t="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ "$(realpath -m -- "$t")" = "$ROOTRP" ] && { echo "refuse to delete locker root" >&2; exit 64; }
    [ -e "$t" ] || [ -L "$t" ] || { echo "no such path" >&2; exit 67; }
    rm -rf -- "$t"
    ;;
  read)
    t="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -L "$t" ] && { echo "refuse symlink" >&2; exit 64; }
    [ -f "$t" ] || { echo "not a file" >&2; exit 67; }
    cat -- "$t"
    ;;
  zipdir)
    d="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -d "$d" ] || { echo "not a dir" >&2; exit 67; }
    cd "$(dirname -- "$d")" || { echo "cd failed" >&2; exit 67; }
    # Stream a .zip of the folder to stdout (entry-by-entry; bounded memory for big trees).
    exec zip -qr - "$(basename -- "$d")"
    ;;
  write)
    t="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -L "$t" ] && { echo "refuse symlink" >&2; exit 64; }
    [ -d "$t" ] && { echo "is a directory" >&2; exit 73; }
    dir="$(dirname -- "$t")"; [ -d "$dir" ] || { echo "parent missing" >&2; exit 67; }
    tmp="$dir/.apphub-upload.$$.$RANDOM.tmp"
    trap "rm -f -- \"$tmp\"" EXIT
    # Single pass over stdin: write to tmp AND hash simultaneously.
    sh="$(tee -- "$tmp" | sha256sum | cut -d" " -f1)"
    sz="$(stat -c %s -- "$tmp")"
    if [ -n "$SIZE" ] && [ "$SIZE" != "$sz" ]; then echo "incomplete upload (got $sz of $SIZE)" >&2; exit 75; fi
    if [ -n "$SHA" ] && [ "$SHA" != "$sh" ]; then echo "hash mismatch" >&2; exit 75; fi
    mv -f -- "$tmp" "$t"
    trap - EXIT
    printf "%s\t%s\n" "$sh" "$sz"
    ;;
  hash)
    t="$(confined "$P1")" || { echo "out of locker" >&2; exit 64; }
    [ -L "$t" ] && { echo "refuse symlink" >&2; exit 64; }
    [ -f "$t" ] || { echo "not a file" >&2; exit 67; }
    sha256sum -- "$t" | cut -d" " -f1
    ;;
esac
' _ "$OP" "$BASE_ROOT" "$P1" "$P2" "$SHA" "$SIZE"
