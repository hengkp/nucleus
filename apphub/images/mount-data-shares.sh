#!/bin/bash
# Replicate ALL of node1's NAS (192.168.0.103) shares onto a COMPUTE node via fstab, except
# sisplockers (already mounted everywhere). Reads the share list that is generated on node1 at the
# NFS path below (so it always matches node1 — "mount everything like node1"). Idempotent, additive,
# nofail — it's a read/write client mount of an existing export; the NAS itself is not touched, and
# OS perms still decide who can read/write each share.
#
# 1) Generate the list once on node1 (as root):
#      grep 192.168.0.103 /etc/fstab | grep -v sisplockers \
#        | awk '{print $1" "$2" nfs4 _netdev,nofail,vers=4.2 0 0"}' \
#        > /mnt/sisplockers/.apphub-images/bin/dept-shares.fstab
# 2) Apply on every compute node (from node1, as root):
#      for n in node2 node3 node4; do ssh "$n" 'bash /mnt/sisplockers/.apphub-images/bin/mount-data-shares.sh'; done
#
# The hosted-app runner auto-binds every mounted /mnt/<share> into JupyterLab/RStudio (OS perms
# enforce access), so once mounted here they appear in the apps with no further config.
set -u
SRC=/mnt/sisplockers/.apphub-images/bin/dept-shares.fstab
[ -r "$SRC" ] || { echo "missing $SRC — generate it on node1 first (see header)"; exit 1; }
while read -r dev mp rest; do
  [ -z "${dev:-}" ] && continue
  case "$dev" in \#*) continue;; esac
  mkdir -p "$mp"
  grep -q " $mp " /etc/fstab || echo "$dev $mp $rest" >> /etc/fstab
done < "$SRC"
mount -a 2>&1 | grep -iE "192.168.0.103|fail|error" || true
echo "=== $(hostname) ==="
while read -r dev mp rest; do
  [ -z "${dev:-}" ] && continue; case "$dev" in \#*) continue;; esac
  mountpoint -q "$mp" && echo "  ok  $mp" || echo "  MISSING $mp"
done < "$SRC"
