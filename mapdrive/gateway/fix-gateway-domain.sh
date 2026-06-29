#!/usr/bin/env bash
# Finishes the gateway after install-gateway-node1.sh: creates the sambaDomain entry that
# ldapsam needs (the least-privilege pwsync bind can't create it), syncs the local SID,
# fixes APPHUB_SAMBA_DOMAIN_SID, and restarts smbd + the AppHub backend.
# Run as root ON node1, OUTSIDE auto mode (prompts for cn=admin password, reviewed directly):
#   sudo bash fix-gateway-domain.sh
set -Eeuo pipefail
SUFFIX="dc=siriraj,dc=local"
ADMIN_DN="cn=admin,${SUFFIX}"
ENVF="/opt/sisp-apphub/backend/.env"
read -rsp "cn=admin LDAP password: " ADMIN_PW; echo

# Samba's standalone SAM domain == the netbios name (the smbd error said "for NAS").
NB="$(testparm -s --parameter-name 'netbios name' 2>/dev/null | tr -d '[:space:]')"
[ -z "$NB" ] && NB=NAS
echo "==> SAM domain (netbios) = $NB"

# Reuse an existing sambaDomain SID if one is already there; else generate a valid one.
SID="$(ldapsearch -x -H ldap://127.0.0.1 -D "$ADMIN_DN" -w "$ADMIN_PW" -b "$SUFFIX" '(objectClass=sambaDomain)' sambaSID 2>/dev/null | awk '/^sambaSID:/{print $2}' | head -1)"
if [ -z "$SID" ]; then
  SID="S-1-5-21-$((RANDOM*RANDOM+1))-$((RANDOM*RANDOM+1))-$((RANDOM*RANDOM+1))"
  echo "==> creating sambaDomainName=$NB with SID $SID"
  ldapadd -x -H ldap://127.0.0.1 -D "$ADMIN_DN" -w "$ADMIN_PW" <<LDIF
dn: sambaDomainName=${NB},${SUFFIX}
objectClass: sambaDomain
sambaDomainName: ${NB}
sambaSID: ${SID}
sambaAlgorithmicRidBase: 1000
LDIF
else
  echo "==> reusing existing sambaDomain SID $SID"
fi

# Match the local secrets.tdb machine SID to the LDAP domain SID (user SIDs = SID-<rid>).
net setlocalsid "$SID" 2>/dev/null || true

# Point the AppHub drive-password feature at the same SID.
sed -i '/^APPHUB_SAMBA_DOMAIN_SID=/d' "$ENVF"
echo "APPHUB_SAMBA_DOMAIN_SID=${SID}" >> "$ENVF"

systemctl restart smbd nmbd
systemctl restart apphub-backend
sleep 2
echo "==> smbd=$(systemctl is-active smbd)  apphub=$(systemctl is-active apphub-backend)"
echo "==> local SID: $(net getlocalsid 2>/dev/null)"
echo
echo "If smbd is active, the gateway passdb is up. Next:"
echo "  1) A user sets their drive password once in AppHub (Workspace -> Set drive password)."
echo "  2) Test from node1:  smbclient //127.0.0.1/sisplockers -U <user>%<labpw> -c 'ls'"
echo "  3) Tell me — I'll verify ownership, open 445, point nas.sisp.com -> node1, and flip the"
echo "     MapDrive default to the gateway (Infortrend 192.168.0.103 kept as optional)."
