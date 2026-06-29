# Runtime Notes

## App Templates

Templates live in `runtime/templates.json` and can also be edited through the admin API. Users cannot edit commands, images, mounts, or environment variables. They only provide:

- app name
- template
- CPU
- RAM
- time limit
- workspace folder
- optional entrypoint
- visibility

## Container Images

Approved `.sif` images should live under:

```text
/mnt/sisplockers/apphub/images
```

The default templates expect:

- `jupyterlab.sif`
- `rstudio.sif`
- `python-apps.sif`
- `galaxy-tool-dev.sif`

The runner fails clearly if Apptainer/Singularity or the image is missing.

Image definitions live under `runtime/definitions/`. Build them from a node that has
Apptainer or Singularity and can write to the shared image directory:

```bash
cd /opt/sisp-apphub
sudo cp -a runtime/. /mnt/sisplockers/apphub/runtime/
sudo chmod 0755 deploy/build-runtime-images-node2.sh deploy/prewarm-runtime-images.sh
sudo APPHUB_DEFINITION_ROOT=/mnt/sisplockers/apphub/runtime/definitions \
  deploy/build-runtime-images-node2.sh
```

After images are built, prewarm them on the compute nodes:

```bash
deploy/prewarm-runtime-images.sh
```

This catches missing runtime dependencies before users click Launch and reduces
first-start latency by forcing each node to touch the shared SIF files.

## Runtime Readiness

On production node1, `APPHUB_ALLOW_MOCK_LAUNCHES=0` prevents mock-mode launches
from creating fake routes. Keep that setting unless you are deliberately running
a smoke test. Before switching to `APPHUB_SLURM_MODE=slurm`, confirm:

- `python-apps.sif`, `jupyterlab.sif`, `rstudio.sif`, and `galaxy-tool-dev.sif` exist.
- `node2-node4` can run `apptainer exec` or `singularity exec` against each image.
- A launch smoke test succeeds for Static HTML, JupyterLab, RStudio, and Galaxy Tool Dev.
- The route opens through `https://<app>-<user>.app.sisp.com` after LDAP login.

## Slurm Jobs

Each launch creates:

```text
/var/lib/sisp-apphub/jobs/<app-id>/manifest.json
/var/lib/sisp-apphub/jobs/<app-id>/job.sh
/var/lib/sisp-apphub/jobs/<app-id>/status.json
/var/lib/sisp-apphub/logs/<app-id>/stdout.log
/var/lib/sisp-apphub/logs/<app-id>/stderr.log
```

The job writes its assigned host before starting the container. AppHub reconciliation turns that into an nginx route.

## MapDrive

AppHub links to `https://mapdrive.sisp.com` and reports the current username. Direct Infortrend SMB can still show wrong Linux UID/GID for Windows-created files. The long-term fix should be a separate LDAP/NSS Samba gateway mounted to the NAS by NFS, then validated with Windows SMB writes before users are moved off direct Infortrend SMB.

Current AppHub drive data exposes user-specific Windows, macOS, and Linux paths.
The planned Samba gateway should be introduced as a pilot, not by replacing the
direct NAS path immediately:

1. Build a Linux Samba gateway VM or node service joined to LDAP/NSS.
2. Mount `/mnt/sisplockers` from the NAS by NFS.
3. Export SMB shares from the gateway with `force user` disabled.
4. Validate that Windows-created files show the expected LDAP UID/GID on Linux.
5. Move MapDrive recommendations from the direct NAS SMB path to the gateway path.
