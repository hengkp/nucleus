#!/bin/zsh
set -e

# Refactor (ADR-004): connect to the SISP CIFS GATEWAY, not the Infortrend NAS directly.
# The gateway authenticates against OpenLDAP and stamps correct ownership.
NAS_HOST="nas.sisp.com"
SHARES=(
  "sisplockers"
  "shared"
  "research"
  "CRCproject"
  "admin_dept"
  "admin_sp"
  "filing"
  "hr"
  "postgraduate"
  "purchasing"
  "undergraduate"
)

printf '\033[1;36m'
echo "  ┌────────────────────────────────────────────┐"
echo "  │   SISP MapDrive  ·  macOS helper            │"
echo "  └────────────────────────────────────────────┘"
printf '\033[0m'
echo "  Map your lab drive — ownership stamped by the LDAP gateway."
echo "  Gateway: ${NAS_HOST}"
echo

index=1
for share in "${SHARES[@]}"; do
  printf "%2d) %s\n" "${index}" "${share}"
  index=$((index + 1))
done

echo
printf "Choose share number [1 for sisplockers]: "
read choice
choice="${choice:-1}"

if ! [[ "${choice}" =~ ^[0-9]+$ ]] || [ "${choice}" -lt 1 ] || [ "${choice}" -gt "${#SHARES[@]}" ]; then
  echo "Invalid share number."
  exit 1
fi

share="${SHARES[$choice]}"
printf "LDAP username: "
read username

if [ -z "${username}" ]; then
  echo "Username is required."
  exit 1
fi

# Unmount any existing mount of this gateway share first, so a stale session/identity from
# a previous connection isn't reused (parity with the Windows pre-connect purge).
existing="$(mount | awk -v h="${NAS_HOST}" -v s="${share}" '$0 ~ ("//.*" h "/" s) {print $3}')"
if [ -n "${existing}" ]; then
  echo "Unmounting existing ${existing} ..."
  umount "${existing}" 2>/dev/null || diskutil unmount "${existing}" 2>/dev/null || true
fi

encoded_user="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "${username}" 2>/dev/null || printf "%s" "${username}")"
url="smb://${encoded_user}@${NAS_HOST}/${share}"

echo
echo "Opening ${url}"
echo "macOS will ask for the LDAP password if it is not already in Keychain."
echo "If a stale password is remembered, remove it: Keychain Access -> search ${NAS_HOST}."
open "${url}"
