# LDAP changes for AppHub auth + drive-password

Apply on node1 (the OpenLDAP host). Structure verified live: base `dc=siriraj,dc=local`,
users `ou=People`, groups `ou=group` (posixGroup/memberUid).

## 1. Role groups (no secrets)
```
ldapadd -x -D "cn=admin,dc=siriraj,dc=local" -W -f 10-role-groups.ldif
```
Creates `cn=apphub-power` (gid 100100) and `cn=sisp-admins` (gid 100200). Edit `memberUid`
to set who is power/admin. Backend maps: `sisp-admins`→admin, `apphub-power`→power, else researcher.

## 2. Service accounts (generate secrets; do NOT commit the filled file)
```
APPHUB_RO_PW=$(slappasswd -s "$(openssl rand -base64 24)")   # also keep cleartext -> Authelia .env
PWSYNC_PW=$(slappasswd   -s "$(openssl rand -base64 24)")    # also keep cleartext -> backend .env
sed -e "s|{APPHUB_RO_SSHA}|$APPHUB_RO_PW|" -e "s|{PWSYNC_SSHA}|$PWSYNC_PW|" \
    20-service-accounts.ldif.example | ldapadd -x -D "cn=admin,dc=siriraj,dc=local" -W
```

## 3. Samba schema (needed before sambaNTPassword can be written)
Load the Samba LDAP schema into slapd (path varies by distro; from the `samba` package):
```
# example (cn=config style):
ldapadd -Y EXTERNAL -H ldapi:/// -f /usr/share/doc/samba/examples/LDAP/samba.ldif
```

## 4. ACL: let samba-pwsync write ONLY the samba attrs (least privilege)
Add an olcAccess rule (cn=config) so the drive-password flow can set hashes but nothing else:
```
dn: olcDatabase={1}mdb,cn=config
changetype: modify
add: olcAccess
olcAccess: {0}to attrs=sambaNTPassword,sambaPwdLastSet,sambaSID,sambaAcctFlags
  by dn.exact="cn=samba-pwsync,dc=siriraj,dc=local" write
  by self read
  by * none
```
(Adjust the database index `{1}mdb` to match `ldapsearch -Y EXTERNAL -H ldapi:/// -b cn=config -LLL "(olcDatabase=*)" dn`.)

## 5. Domain SID (for sambaSID on first set)
After Samba is provisioned on the gateway: `net getlocalsid` → put it in the backend env as
`APPHUB_SAMBA_DOMAIN_SID`. The drive-password flow derives each user's `sambaSID` as
`<domainSID>-<2*uidNumber+1000>` when first adding `sambaSamAccount`.

## Notes
- StartTLS: once the internal CA is in place, switch binds to `ldaps://` (passwords cross the
  wire during set — keep it on the trusted LAN until then).
- No existing user password is rotated by any of this; the drive-password flow only *adds* an
  NT-hash of the password the user already uses.
