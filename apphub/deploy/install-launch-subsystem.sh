#!/usr/bin/env bash
set -Eeuo pipefail
NGBAK=/etc/nginx/conf.d/44-apphub-apps.conf.absent

mkdir -p /opt/sisp-apphub/bin /etc/nginx/apphub
install -m 0755 -o root -g root /tmp/apphub-sbatch-as-user.sh /opt/sisp-apphub/bin/apphub-sbatch-as-user.sh
install -m 0755 -o root -g root /tmp/apphub-runner.sh /opt/sisp-apphub/bin/apphub-runner.sh
sed -i 's/\r$//' /opt/sisp-apphub/bin/apphub-sbatch-as-user.sh /opt/sisp-apphub/bin/apphub-runner.sh
echo "wrapper+runner installed"

# sudoers: nodeadmin may run the wrapper as root + reload nginx (NOPASSWD, scoped)
cat > /etc/sudoers.d/apphub <<'EOF'
nodeadmin ALL=(root) NOPASSWD: /opt/sisp-apphub/bin/apphub-sbatch-as-user.sh *
nodeadmin ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx
EOF
chmod 440 /etc/sudoers.d/apphub
visudo -cf /etc/sudoers.d/apphub || { echo "BAD SUDOERS — removing"; rm -f /etc/sudoers.d/apphub; exit 2; }
echo "sudoers OK"

# self-signed *.app.sisp.com cert (stopgap; replace with DNS-01 wildcard later)
if [ ! -f /etc/ssl/certs/app-sisp.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout /etc/ssl/private/app-sisp.key -out /etc/ssl/certs/app-sisp.crt \
    -subj "/CN=*.app.sisp.com" -addext "subjectAltName=DNS:*.app.sisp.com" >/dev/null 2>&1
  chmod 600 /etc/ssl/private/app-sisp.key
  echo "self-signed *.app cert created"
fi

touch /etc/nginx/apphub/routes.upstreams

# install the *.app vhost (with backup if exists)
[ -f /etc/nginx/conf.d/44-apphub-apps.conf ] && cp -a /etc/nginx/conf.d/44-apphub-apps.conf "/etc/nginx/conf.d/44-apphub-apps.conf.bak-$(date +%s)"
cp /tmp/44-apphub-apps.conf /etc/nginx/conf.d/44-apphub-apps.conf

# backend env: point routes at the upstreams map + enable debounced nginx reload
E=/opt/sisp-apphub/backend/.env
sed -i "s|^APPHUB_ROUTES_MAP=.*|APPHUB_ROUTES_MAP=/etc/nginx/apphub/routes.upstreams|" "$E"
sed -i "s|^APPHUB_NGINX_RELOAD=.*|APPHUB_NGINX_RELOAD=sudo /usr/bin/systemctl reload nginx|" "$E"
grep -q '^APPHUB_SBATCH_WRAPPER=' "$E" || echo "APPHUB_SBATCH_WRAPPER=/opt/sisp-apphub/bin/apphub-sbatch-as-user.sh" >> "$E"

# validate nginx; only reload if good (else remove the new conf to stay safe)
if nginx -t 2>/tmp/ngt; then
  systemctl reload nginx; echo "nginx reloaded OK"
else
  echo "nginx -t FAILED — removing new *.app conf, not reloading:"; cat /tmp/ngt
  rm -f /etc/nginx/conf.d/44-apphub-apps.conf; exit 3
fi

systemctl restart apphub-backend; sleep 2
echo "backend: $(systemctl is-active apphub-backend)"
echo "=== verify other vhosts still OK ==="
for h in apphub.sisp.com zulip.sisp.com leantime.sisp.com; do
  printf "%-22s %s\n" "$h" "$(curl -sk -o /dev/null -w '%{http_code}' -H "Host: $h" https://127.0.0.1/)"
done
echo INSTALL-DONE
