#!/usr/bin/env bash
# Set every user locker directory under /mnt/sisplockers to 0775 (collaboration: lab group
# rwx, others r-x). Backs up current modes first for rollback. Directory-level only — files
# inside keep their own perms (already-readable files become reachable once the dir opens;
# files explicitly 0600 stay private to their owner).
set -Eeuo pipefail
ROOT=/mnt/sisplockers
TS=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo bak)
BK=/root/locker-perms-backup-$TS.txt

echo "== backing up current locker dir perms -> $BK =="
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%m %U %G %p\n' > "$BK"
echo "  saved $(wc -l < "$BK") entries"

echo "== applying chmod 0775 to locker dirs =="
n=0
while IFS= read -r d; do chmod 0775 "$d" && n=$((n+1)); done < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d)
echo "  updated $n directories"

echo "== sample (first 6) =="
ls -ld "$ROOT"/*/ 2>/dev/null | head -6 | sed 's/^/  /'
echo
echo "Rollback:  while read m u g p; do chmod \"\$m\" \"\$p\"; done < $BK"
