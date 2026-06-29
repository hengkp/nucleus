#!/usr/bin/env bash
set -euo pipefail

archive="${1:-/tmp/apphub-deploy.tgz}"
app_root="/opt/sisp-apphub"
backup_root="/opt/sisp-apphub.backup.$(date +%Y%m%d%H%M%S)"
web_root="/var/www/apphub.sisp.com"
state_root="/var/lib/sisp-apphub"
env_dir="/etc/sisp-apphub"
nginx_apphub_dir="/etc/nginx/apphub"
nginx_conf="/etc/nginx/conf.d/43-apphub-sispcom.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root, for example: sudo bash deploy/install-node1.sh" >&2
  exit 77
fi

if [ ! -r "$archive" ]; then
  echo "Archive is not readable: $archive" >&2
  exit 66
fi

systemctl stop apphub.service 2>/dev/null || true

if [ -d "$app_root" ]; then
  mv "$app_root" "$backup_root"
fi
mkdir -p "$app_root"
tar -xzf "$archive" -C "$app_root"

if ! id apphub >/dev/null 2>&1; then
  useradd --system --home "$state_root" --shell /usr/sbin/nologin apphub
fi

mkdir -p "$state_root/jobs" "$state_root/logs" "$env_dir" "$nginx_apphub_dir" "$web_root"
chown -R apphub:apphub "$state_root" "$nginx_apphub_dir"
chmod 0750 "$state_root" "$nginx_apphub_dir"

if getent group sisp >/dev/null 2>&1; then
  sisp_gid="$(getent group sisp | cut -d: -f3)"
  if [ -n "$sisp_gid" ] && ! id -nG apphub | grep -qw apphub-sisp; then
    getent group apphub-sisp >/dev/null 2>&1 || groupadd -o -g "$sisp_gid" apphub-sisp
    usermod -aG apphub-sisp apphub
  fi
fi

for d in /mnt/sisplockers/apphub /mnt/sisplockers/apphub/images /mnt/sisplockers/apphub/workspaces /mnt/sisplockers/apphub/jobs /mnt/sisplockers/apphub/logs /mnt/sisplockers/apphub/runtime; do
  mkdir -p "$d"
done
chgrp -R sisp /mnt/sisplockers/apphub 2>/dev/null || true
chmod -R 2775 /mnt/sisplockers/apphub 2>/dev/null || true

cp -a "$app_root/web/." "$web_root/"
chmod 0755 "$app_root/runtime/wrappers/"*.sh "$app_root/runtime/wrappers/"*.py
cp -a "$app_root/runtime/." /mnt/sisplockers/apphub/runtime/
chgrp -R sisp /mnt/sisplockers/apphub/runtime 2>/dev/null || true
chmod 0644 /mnt/sisplockers/apphub/runtime/templates.json
chmod 0755 /mnt/sisplockers/apphub/runtime/wrappers/*.sh /mnt/sisplockers/apphub/runtime/wrappers/*.py

install -m 0644 "$app_root/deploy/apphub.service" /etc/systemd/system/apphub.service
install -m 0644 "$app_root/deploy/apphub-nginx.conf" "$nginx_conf"
install -m 0750 "$app_root/deploy/apphub-nginx-reload" /usr/local/sbin/apphub-nginx-reload
install -m 0440 "$app_root/deploy/sudoers-apphub" /etc/sudoers.d/apphub
if [ ! -f "$nginx_apphub_dir/routes.map" ]; then
  install -m 0640 -o apphub -g apphub "$app_root/deploy/routes.map.example" "$nginx_apphub_dir/routes.map"
fi

cat > "$env_dir/apphub.env" <<'ENV'
DATABASE_URL=postgresql://apphub@%2Fvar%2Frun%2Fpostgresql/sisp_apphub
APPHUB_ADMIN_USERS=nodeadmin,admin
APPHUB_ADMIN_GROUPS=sisp-admins
APPHUB_DEV_AUTH=0
APPHUB_SLURM_MODE=mock
APPHUB_ALLOW_MOCK_LAUNCHES=0
APPHUB_CLUSTER_NODES=node1,node2,node3,node4
APPHUB_CLUSTER_MAX_CPUS=112
APPHUB_CLUSTER_MAX_MEMORY_MB=515072
APPHUB_RUNTIME_ROOT=/mnt/sisplockers/apphub/runtime
APPHUB_TEMPLATE_PATH=/mnt/sisplockers/apphub/runtime/templates.json
APPHUB_RUNNER_PATH=/mnt/sisplockers/apphub/runtime/wrappers/apphub-runner.sh
APPHUB_SBATCH_WRAPPER=/opt/sisp-apphub/runtime/wrappers/apphub-sbatch-as-user.sh
APPHUB_SCANCEL_WRAPPER=/opt/sisp-apphub/runtime/wrappers/apphub-sbatch-as-user.sh
APPHUB_JOB_ROOT=/mnt/sisplockers/apphub/jobs
APPHUB_LOG_ROOT=/mnt/sisplockers/apphub/logs
ENV
chown root:apphub "$env_dir/apphub.env"
chmod 0640 "$env_dir/apphub.env"

if command -v psql >/dev/null 2>&1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -tc "select 1 from pg_roles where rolname = 'apphub'" | grep -q 1 || \
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "create role apphub login"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -tc "select 1 from pg_database where datname = 'sisp_apphub'" | grep -q 1 || \
    sudo -u postgres createdb -O apphub sisp_apphub
  if sudo -u apphub psql -d sisp_apphub -v ON_ERROR_STOP=1 -f "$app_root/server/sql/schema.sql"; then
    :
  else
    sudo -u postgres psql -d sisp_apphub -v ON_ERROR_STOP=1 -f "$app_root/server/sql/schema.sql"
    sudo -u postgres psql -d sisp_apphub -v ON_ERROR_STOP=1 -c "grant all privileges on all tables in schema public to apphub"
    sudo -u postgres psql -d sisp_apphub -v ON_ERROR_STOP=1 -c "grant all privileges on all sequences in schema public to apphub"
  fi
fi

cd "$app_root/server"
npm install --omit=dev --no-audit --no-fund

systemctl daemon-reload
systemctl enable apphub.service >/dev/null
systemctl restart apphub.service

nginx -t
systemctl reload nginx
systemctl --no-pager --full status apphub.service | sed -n '1,18p'
