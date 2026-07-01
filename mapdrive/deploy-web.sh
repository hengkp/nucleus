#!/usr/bin/env bash
#
# deploy-web.sh -- publish the MapDrive website (mapdrive/web) to node1, the host
# behind https://mapdrive.sisp.com.
#
# WHY THIS EXISTS
#   node1 sits on the lab LAN and is unreachable from GitHub CI, so the site is
#   pushed from a workstation over SSH. In the past the live files were edited
#   directly on the server, drifted away from git, and were nearly lost on the
#   next redeploy. ALWAYS publish with this script from a clean checkout instead
#   of editing the server in place. Run it with --check first to see whether the
#   live site still matches git.
#
# WHAT IT DOES
#   * refuses to deploy if any served text file (html/js/css/json) contains a
#     non-ASCII byte -- the site's "no special characters" house rule;
#   * mirrors mapdrive/web/ -> /var/www/mapdrive.sisp.com/, EXCEPT downloads/,
#     which holds the CI-built installer + macOS zip and is published separately
#     (GitHub Actions artifact -> pscp; not managed here);
#   * backs up every file it overwrites (<file>.bak-<timestamp>);
#   * restores ownership (www-data) and permissions (dirs 755, files 644);
#   * verifies the live site returns 200 afterwards.
#
# USAGE (from Git Bash on the workstation; requires PuTTY plink/pscp)
#   ./mapdrive/deploy-web.sh --check     # dry run: report drift, write nothing
#   ./mapdrive/deploy-web.sh             # publish git -> server
#   ./mapdrive/deploy-web.sh --prune     # also delete server files absent from git (true mirror)
#
# CONFIG (all optional env vars; nothing secret is stored in this file)
#   MAPDRIVE_DEPLOY_PW   ssh password for the deploy user (else you are prompted)
#   MAPDRIVE_HOST        default 192.168.0.25   (LAN-internal, not internet-routable)
#   MAPDRIVE_USER        default nodeadmin
#   MAPDRIVE_DOCROOT     default /var/www/mapdrive.sisp.com
#   PLINK / PSCP         paths to the PuTTY tools (default under C:\Program Files\PuTTY)
#
set -euo pipefail

HOST="${MAPDRIVE_HOST:-192.168.0.25}"
SSH_USER="${MAPDRIVE_USER:-nodeadmin}"
DOCROOT="${MAPDRIVE_DOCROOT:-/var/www/mapdrive.sisp.com}"
VHOST="mapdrive.sisp.com"
PLINK="${PLINK:-/c/Program Files/PuTTY/plink.exe}"
PSCP="${PSCP:-/c/Program Files/PuTTY/pscp.exe}"
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/web" && pwd)"

MODE=deploy
case "${1:-}" in
  --check) MODE=check ;;
  --prune) MODE=prune ;;
  ""|--deploy) MODE=deploy ;;
  *) echo "usage: $(basename "$0") [--check|--prune]"; exit 2 ;;
esac

for tool in "$PLINK" "$PSCP"; do
  [ -x "$tool" ] || command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: not found: $tool (set PLINK=/PSCP=)"; exit 1; }
done

# --- 1. special-character guard on the served text files ----------------------
echo "==> Linting served files (must be pure ASCII)..."
offenders=""
while IFS= read -r f; do
  if LC_ALL=C grep -qP '[^\x00-\x7F]' "$WEB/$f"; then offenders="$offenders$f"$'\n'; fi
done < <(cd "$WEB" && find . -maxdepth 2 -type f \
           \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.json' \) \
           ! -path './assets/*' ! -path './downloads/*' | sed 's|^\./||')
if [ -n "$offenders" ]; then
  echo "REFUSING TO DEPLOY -- non-ASCII characters in:"
  printf '%s' "$offenders" | sed 's/^/   /'
  echo "Convert to ASCII first: dash -> -, curly quotes -> ' or \", arrow -> >, ellipsis -> ..., middot -> -"
  exit 1
fi
echo "    clean."

# --- 2. credentials -----------------------------------------------------------
PW="${MAPDRIVE_DEPLOY_PW:-}"
if [ -z "$PW" ]; then read -rs -p "SSH password for $SSH_USER@$HOST: " PW; echo; fi
plink_run(){ "$PLINK" -batch -ssh -pw "$PW" "$SSH_USER@$HOST" "$1"; }

# --- 3. stage the repo web tree (minus downloads/ and backups) and upload -----
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp -r "$WEB/." "$STAGE/"
rm -rf "$STAGE/downloads"
find "$STAGE" -name '*.bak*' -delete 2>/dev/null || true
REMOTE_STAGE="/tmp/mapdrive-web-stage"
plink_run "rm -rf $REMOTE_STAGE && mkdir -p $REMOTE_STAGE"
"$PSCP" -batch -pw "$PW" -r "$STAGE"/* "$SSH_USER@$HOST:$REMOTE_STAGE/" >/dev/null

# downloads/ and *.bak* live on the server but are not repo-managed: never touch them
EXCL="--exclude=downloads --exclude=downloads/*** --exclude=*.bak*"

# --- 4. check mode: report drift, change nothing ------------------------------
if [ "$MODE" = check ]; then
  echo "==> Drift check: git vs live $VHOST (compares content only, writes nothing)"
  # -r --checksum, no -a: ignore mtime/perms/group so only real content/existence
  # differences show. --delete surfaces live files that are not in git.
  out="$(plink_run "rsync -rn --checksum --delete --itemize-changes $EXCL $REMOTE_STAGE/ $DOCROOT/ 2>/dev/null")"
  plink_run "rm -rf $REMOTE_STAGE"
  if [ -z "$out" ]; then
    echo "    IN SYNC -- the live site matches git."
  else
    echo "    DRIFT:"
    printf '%s\n' "$out" | awk 'NF{ if($1=="*deleting") printf "      server-only (not in git): %s\n",$2; else printf "      content differs:          %s\n",$2 }'
    echo "    Publish with:  ./mapdrive/deploy-web.sh        (or --prune to remove server-only files)"
  fi
  exit 0
fi

# --- 5. deploy ----------------------------------------------------------------
TS=$(date +%Y%m%d-%H%M%S)
DEL=""; [ "$MODE" = prune ] && DEL="--delete"
echo "==> Publishing git -> $VHOST (backups .bak-$TS)${DEL:+, pruning server-only files}"
# -r --checksum (no -a): transfer only content-changed files, so --backup makes a
# .bak only for files that actually change; ownership/perms are set explicitly below.
plink_run "set -e
  sudo rsync -r --checksum --backup --suffix='.bak-$TS' $DEL $EXCL '$REMOTE_STAGE/' '$DOCROOT/'
  sudo chown -R www-data:www-data '$DOCROOT'
  sudo find '$DOCROOT' -type d -exec chmod 755 {} +
  sudo find '$DOCROOT' -type f ! -name '*.bak*' -exec chmod 644 {} +
  rm -rf $REMOTE_STAGE
  echo '    synced.'"

echo "==> Verifying live site..."
for u in / /config/share-presets.json; do
  code="$(plink_run "curl -sk -o /dev/null -w '%{http_code}' --resolve $VHOST:443:127.0.0.1 https://$VHOST$u")"
  echo "   $u -> $code"
done
echo "Done. Re-run with --check any time to confirm git and the live site still match."
