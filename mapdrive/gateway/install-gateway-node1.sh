#!/usr/bin/env bash
# ============================================================================
# Complete the SISP CIFS gateway on node1 (ldapsam + self-serve drive password).
# Run as root ON node1, OUTSIDE auto mode (this performs the production-LDAP schema
# + ACL writes that the agent intentionally did not auto-apply).
#
#   sudo bash install-gateway-node1.sh
#
# Already done by the agent (safe groundwork): Samba 4.15 installed; ldapsam verified;
# S1 ownership gate GREEN; LDAP backed up to /root/ldap-{config,data}-backup-20260628.ldif.
# Rollback: see the bottom of this file.
# ============================================================================
set -Eeuo pipefail
SUFFIX="dc=siriraj,dc=local"
PEOPLE="ou=People,${SUFFIX}"
PWSYNC_DN="cn=samba-pwsync,${SUFFIX}"
ADMIN_DN="cn=admin,${SUFFIX}"
SCHEMA="/usr/share/doc/samba/examples/LDAP/samba.ldif"
ENVF="/opt/sisp-apphub/backend/.env"
SMBCONF_SRC="${1:-/tmp/smb.conf.node1}"   # pass the node1 smb.conf path, or place it at /tmp

read -rsp "cn=admin LDAP password: " ADMIN_PW; echo
say(){ echo "==> $*"; }

# ---- 1) Samba schema into cn=config (idempotent) ----------------------------
if [ "$(ldapsearch -Y EXTERNAL -H ldapi:/// -b cn=schema,cn=config dn 2>/dev/null | grep -ic samba)" = 0 ]; then
  say "loading Samba schema"; ldapadd -Y EXTERNAL -H ldapi:/// -f "$SCHEMA"
else say "Samba schema already present"; fi

# ---- 2) least-privilege pwsync bind ----------------------------------------
PWSYNC_PW="$(openssl rand -base64 24)"
if ldapsearch -x -H ldap://127.0.0.1 -D "$ADMIN_DN" -w "$ADMIN_PW" -b "$PWSYNC_DN" -s base dn >/dev/null 2>&1; then
  say "pwsync bind already exists — reusing; set PWSYNC_PW yourself if unknown"; PWSYNC_PW=""
else
  say "creating $PWSYNC_DN"
  ldapadd -x -H ldap://127.0.0.1 -D "$ADMIN_DN" -w "$ADMIN_PW" <<LDIF
dn: ${PWSYNC_DN}
objectClass: simpleSecurityObject
objectClass: organizationalRole
cn: samba-pwsync
description: AppHub Samba NT-hash writer (drive-password self-service)
userPassword: $(slappasswd -s "$PWSYNC_PW")
LDIF
fi

# ---- 3) ACLs: hide NT hashes from the world, let pwsync write samba attrs ----
# Inserted BEFORE the existing catch-all "{2} to * by * read" so NT hashes are NOT
# world-readable. Idempotent guard: only add if no sambaNTPassword rule exists yet.
if ! ldapsearch -Y EXTERNAL -H ldapi:/// -b cn=config '(olcDatabase={1}mdb)' olcAccess 2>/dev/null | grep -qi sambaNTPassword; then
  say "adding olcAccess rules (protect NT hashes; pwsync writes)"
  ldapmodify -Y EXTERNAL -H ldapi:/// <<LDIF
dn: olcDatabase={1}mdb,cn=config
changetype: modify
add: olcAccess
olcAccess: {0}to attrs=sambaNTPassword,sambaLMPassword by dn.exact="${PWSYNC_DN}" write by * none
-
add: olcAccess
olcAccess: {1}to attrs=sambaSID,sambaAcctFlags,sambaPwdLastSet,sambaPwdMustChange,objectClass by dn.exact="${PWSYNC_DN}" write by * read
LDIF
else say "samba olcAccess already present"; fi

# verify LDAP still healthy
say "slapd=$(systemctl is-active slapd)  getent=$(getent passwd kriengkraip | cut -d: -f3)"

# ---- 4) smb.conf + ldap admin secret + domain SID + start smbd --------------
[ -f "$SMBCONF_SRC" ] || { echo "place the node1 smb.conf at $SMBCONF_SRC first (gateway/smb.conf.node1)"; exit 2; }
say "installing smb.conf"; install -m 0644 "$SMBCONF_SRC" /etc/samba/smb.conf
testparm -s >/dev/null
if [ -n "$PWSYNC_PW" ]; then say "storing ldap admin secret for smbd"; smbpasswd -w "$PWSYNC_PW"; fi
say "domain SID: $(net getlocalsid 2>/dev/null | sed 's/.*: //')   <-- put this in APPHUB_SAMBA_DOMAIN_SID"
# Don't abort if smbd can't start yet (it needs the sambaDomain entry, created by
# fix-gateway-domain.sh) — the .env wiring below must still run.
systemctl enable --now smbd nmbd || say "smbd not up yet — run fix-gateway-domain.sh, then it will start"
say "smbd=$(systemctl is-active smbd)  445=$(ss -ltn | grep -c :445)"

# ---- 5) enable the AppHub self-serve drive-password feature ------------------
SID="$(net getlocalsid | sed 's/.*: //')"
if [ -n "$PWSYNC_PW" ] && [ -f "$ENVF" ]; then
  say "wiring drive-password into $ENVF"
  {
    echo "APPHUB_DRIVE_PW_ENABLED=1"
    echo "APPHUB_LDAP_URI=ldap://127.0.0.1"
    echo "APPHUB_LDAP_PEOPLE_BASE=${PEOPLE}"
    echo "APPHUB_PWSYNC_DN=${PWSYNC_DN}"
    echo "APPHUB_PWSYNC_PASSWORD=${PWSYNC_PW}"
    echo "APPHUB_SAMBA_DOMAIN_SID=${SID}"
  } >> "$ENVF"
  systemctl restart apphub-backend
  say "apphub-backend=$(systemctl is-active apphub-backend)"
else
  say "pwsync pw unknown or .env missing — set APPHUB_PWSYNC_PASSWORD + APPHUB_SAMBA_DOMAIN_SID=$SID manually, then restart apphub-backend"
fi

cat <<'NEXT'

==> NEXT (manual, verifiable):
 1. In AppHub -> Workspace (or Account) -> "Set drive password": a user enters their
    LAB password once. This binds as them (no rotation) and writes sambaNTPassword.
 2. Test the mount on node1 itself:
      smbclient //127.0.0.1/sisplockers -U <user>%<labpw> -c 'ls; put /etc/hostname p; ls'
      ls -lan /mnt/sisplockers/<user>/p     # owner must be the user's uid (e.g. 10000)
 3. Firewall: ensure 445/tcp reachable from the LAN (clients 192.168.0.0/24).
 4. DNS: point nas.sisp.com -> 192.168.0.25 (this node), or use the IP in the client.
 5. Flip MapDrive default to the gateway (keep Infortrend optional) — deploy the repo
    web/config/share-presets.json (server=nas.sisp.com) to /var/www/mapdrive.sisp.com/config/.

==> ROLLBACK:
  systemctl disable --now smbd nmbd
  # remove the two olcAccess rules you added (ldapmodify delete {0}/{1} on olcDatabase={1}mdb)
  # schema cannot be cleanly unloaded, but it's inert if unused; full restore:
  #   slapd backups are at /root/ldap-{config,data}-backup-20260628.ldif (rebuild slapd from these only if needed)
  ldapdelete -x -D "cn=admin,dc=siriraj,dc=local" -W cn=samba-pwsync,dc=siriraj,dc=local
NEXT
