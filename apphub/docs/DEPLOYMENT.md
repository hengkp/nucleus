# Deployment

Target layout on node1:

```text
/opt/sisp-apphub/server
/opt/sisp-apphub/runtime
/var/www/apphub.sisp.com
/var/lib/sisp-apphub/jobs
/var/lib/sisp-apphub/logs
/etc/sisp-apphub/apphub.env
/etc/nginx/apphub/routes.map
```

## Baseline

1. Reserve `31000-31999` for AppHub-launched user apps.
2. Confirm `node2`, `node3`, and `node4` can run Slurm jobs for LDAP users and see the same workspace/image paths.
3. Install Apptainer on node1-node4. The live node1 check on 2026-06-26 found Docker installed but no Apptainer/Singularity binary.
4. Create shared paths:

```bash
sudo mkdir -p /mnt/sisplockers/apphub/images
sudo mkdir -p /mnt/sisplockers/apphub/workspaces
```

## PostgreSQL

Create the database and load the schema:

```bash
sudo -u postgres createdb sisp_apphub
sudo -u postgres psql sisp_apphub < /opt/sisp-apphub/server/sql/schema.sql
```

Set `DATABASE_URL=postgres:///sisp_apphub` in `/etc/sisp-apphub/apphub.env`.

## Service

```bash
sudo useradd --system --home /var/lib/sisp-apphub --shell /usr/sbin/nologin apphub
sudo mkdir -p /var/lib/sisp-apphub/jobs /var/lib/sisp-apphub/logs /etc/sisp-apphub /etc/nginx/apphub
sudo chown -R apphub:apphub /var/lib/sisp-apphub
sudo cp deploy/apphub.service /etc/systemd/system/apphub.service
sudo cp deploy/apphub.env.example /etc/sisp-apphub/apphub.env
sudo cp deploy/routes.map.example /etc/nginx/apphub/routes.map
sudo cp deploy/apphub-nginx-reload /usr/local/sbin/apphub-nginx-reload
sudo chmod 0750 /usr/local/sbin/apphub-nginx-reload
sudo cp deploy/sudoers-apphub /etc/sudoers.d/apphub
sudo chmod 0440 /etc/sudoers.d/apphub
```

Install Node dependencies in `/opt/sisp-apphub/server`, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now apphub
```

## Nginx

1. Point DNS:

```text
apphub.sisp.com   -> 192.168.0.25
*.app.sisp.com    -> 192.168.0.25
```

2. Copy `deploy/apphub-nginx.conf` to `/etc/nginx/conf.d/43-apphub-sispcom.conf`.
3. Replace the placeholder auth header lines with the existing SISP LDAP `auth_request` include or equivalent Basic/OIDC LDAP gateway. AppHub trusts `X-Remote-User` only after nginx has authenticated the request.
4. Validate and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Slurm Wrapper

The AppHub service user must only be able to submit or cancel jobs through:

```text
/opt/sisp-apphub/runtime/wrappers/apphub-sbatch-as-user.sh
```

The wrapper validates the target user, requires job scripts under `/var/lib/sisp-apphub/jobs`, and runs `sbatch`/`scancel` as the real LDAP/Linux user. That preserves file ownership in shared workspaces.

## Route Updates

AppHub writes `/etc/nginx/apphub/routes.map` when an app has a live target host and port. `APPHUB_NGINX_RELOAD_CMD=/usr/local/sbin/apphub-nginx-reload` validates nginx before reload.

Normal apps are time-limited by Slurm. Persistent/public apps should remain pending until an admin approves the app and route.
