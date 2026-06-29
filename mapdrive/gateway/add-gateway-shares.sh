#!/usr/bin/env bash
# Serve the lab's NFS-exported department/project shares through the node1 CIFS gateway, so
# users can map ANY of them via the gateway (correct ownership) instead of direct-to-NAS.
# Mounts each export on node1 + adds a Samba share (runs as the connecting user, so OS
# permissions enforce access exactly like a direct mount). Run as root on node1.
#   sudo bash add-gateway-shares.sh
# Only NFS-exported shares are eligible (CIFS-only shares stay Direct-only in MapDrive).
set -Eeuo pipefail
NAS=192.168.0.103
CONF=/etc/samba/smb.conf
MARK="# === apphub gateway department shares (auto-managed) ==="

declare -A EXPORT=(
  [admin_dept]=/Pool-1/Pharm-Storage/admin_dept
  [admin_sp]=/Pool-1/Pharm-Storage/admin_sp
  [Aj-Adisak]=/Pool-1/NAS-Storage/Aj-Adisak
  [CRCproject]=/Pool-1/Bioinfo-Storage/CRCproject
  [filing]=/Pool-1/Pharm-Storage/filing
  [hr]=/Pool-1/Pharm-Storage/hr
  [it_others]=/Pool-1/Pharm-Storage/it_others
  [postgraduate]=/Pool-1/Pharm-Storage/postgraduate
  [purchasing]=/Pool-1/Pharm-Storage/purchasing
  [research]=/Pool-1/Pharm-Storage/research
  [undergraduate]=/Pool-1/Pharm-Storage/undergraduate
  [MutationProfile]=/Pool-1/Biobank-Storage/MutationProfile
  [Rarecyte-folder]=/Pool-1/Rarecyte-Storage/Rarecyte-folder
)
declare -A MP

echo "== mounting NFS exports on node1 =="
for name in "${!EXPORT[@]}"; do
  ex="$NAS:${EXPORT[$name]}"
  existing="$(mount | awk -v e="$ex" '$1==e{print $3}' | head -1)"
  if [ -n "$existing" ]; then MP[$name]="$existing"; echo "  $name already mounted at $existing"; continue; fi
  mp="/mnt/$name"; mkdir -p "$mp"
  if mountpoint -q "$mp"; then MP[$name]="$mp"; else
    mount -t nfs -o vers=4.2 "$ex" "$mp" && MP[$name]="$mp" && echo "  mounted $name -> $mp" || { echo "  FAILED to mount $name (skipping)"; continue; }
  fi
  grep -qF " $mp " /etc/fstab || echo "$ex $mp nfs4 _netdev,nofail,vers=4.2 0 0" >> /etc/fstab
done

echo "== adding Samba share stanzas (idempotent) =="
if grep -qF "$MARK" "$CONF"; then
  echo "  stanzas already present — skipping (edit $CONF to change)"
else
  cp -a "$CONF" "$CONF.bak-$(date +%s 2>/dev/null || echo bak)" 2>/dev/null || true
  { echo ""; echo "$MARK"
    for name in "${!EXPORT[@]}"; do
      [ -n "${MP[$name]:-}" ] || continue
      printf '[%s]\n   comment = %s (SISP gateway)\n   path = %s\n   valid users = @sisp\n   read only = no\n   create mask = 0664\n   directory mask = 2775\n   hide unreadable = yes\n\n' "$name" "$name" "${MP[$name]}"
    done
  } >> "$CONF"
  echo "  appended."
fi

echo "== validate + reload smbd (no session drop) =="
testparm -s >/dev/null
smbcontrol smbd reload-config 2>/dev/null || systemctl reload smbd 2>/dev/null || systemctl restart smbd
echo "smbd=$(systemctl is-active smbd)"
echo "served shares:"; testparm -s 2>/dev/null | grep -E '^\[' | tr -d '[]' | sort | sed 's/^/  /'
