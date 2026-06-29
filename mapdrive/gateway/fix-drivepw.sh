#!/usr/bin/env bash
# Wire the AppHub self-serve drive-password feature to the gateway. Needed because the
# install script exited (set -e) when smbd first failed to start, before it wrote the
# drive-password config — losing the generated samba-pwsync password. This resets that
# bind to a fresh known password, syncs it to smbd's secrets.tdb, and configures AppHub.
# Run as root ON node1, OUTSIDE auto mode:  sudo bash fix-drivepw.sh
set -Eeuo pipefail
SUFFIX="dc=siriraj,dc=local"
ADMIN_DN="cn=admin,${SUFFIX}"
PWSYNC_DN="cn=samba-pwsync,${SUFFIX}"
ENVF="/opt/sisp-apphub/backend/.env"
read -rsp "cn=admin LDAP password: " ADMIN_PW; echo

NEWPW="$(openssl rand -base64 24)"

echo "==> resetting ${PWSYNC_DN} password to a fresh known value"
ldapmodify -x -H ldap://127.0.0.1 -D "$ADMIN_DN" -w "$ADMIN_PW" >/dev/null <<LDIF
dn: ${PWSYNC_DN}
changetype: modify
replace: userPassword
userPassword: $(slappasswd -s "$NEWPW")
LDIF

echo "==> syncing the secret into smbd (ldap admin bind)"
smbpasswd -w "$NEWPW"

SID="$(net getlocalsid 2>/dev/null | sed 's/.*: //')"
echo "==> wiring AppHub drive-password (.env)  SID=$SID"
for k in APPHUB_DRIVE_PW_ENABLED APPHUB_LDAP_URI APPHUB_LDAP_PEOPLE_BASE APPHUB_PWSYNC_DN APPHUB_PWSYNC_PASSWORD APPHUB_SAMBA_DOMAIN_SID; do
  sed -i "/^${k}=/d" "$ENVF"
done
{
  echo "APPHUB_DRIVE_PW_ENABLED=1"
  echo "APPHUB_LDAP_URI=ldap://127.0.0.1"
  echo "APPHUB_LDAP_PEOPLE_BASE=ou=People,${SUFFIX}"
  echo "APPHUB_PWSYNC_DN=${PWSYNC_DN}"
  echo "APPHUB_PWSYNC_PASSWORD=${NEWPW}"
  echo "APPHUB_SAMBA_DOMAIN_SID=${SID}"
} >> "$ENVF"

systemctl restart smbd
systemctl restart apphub-backend
sleep 2
echo "==> apphub=$(systemctl is-active apphub-backend)  smbd=$(systemctl is-active smbd)"
echo "==> now re-run:  sudo bash /tmp/gw-verify.sh"
