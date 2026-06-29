# Deployment

Static web root on node1:

```text
/var/www/mapdrive.sisp.com
```

Node API on node1:

```text
/opt/sisp-mapdrive/server
/var/lib/sisp-mapdrive/support.json
sisp-mapdrive.service
127.0.0.1:8791
```

Expected nginx vhost:

```nginx
server_name mapdrive.sisp.com;
root /var/www/mapdrive.sisp.com;
index index.html;
location /api/ {
    proxy_pass http://127.0.0.1:8791;
}
```

Build the Inno Setup installer before deployment so `web/downloads/SISPDriveMapperSetup.exe` exists.

After copying the `web/` contents to node1, run:

```bash
sudo systemctl restart sisp-mapdrive
sudo nginx -t
sudo systemctl reload nginx
```
