#!/usr/bin/env bash
# apphub-runner.sh — runs INSIDE the SLURM job as the requesting user. Launches the app in a
# Singularity container, binding the user's locker as /workspace, listening on the allocated
# port. (Isolation hardening — loopback+per-job tunnel or firewalling 31000-31999 to node1 —
# is a documented follow-up; today the per-instance vhost is Authelia-gated at the edge.)
set -Eeuo pipefail
# --export=NONE gives a minimal env; ensure /usr/local/bin (singularity) is on PATH.
export PATH="/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:${PATH:-}"

PORT="${APPHUB_PORT:-0}"
TEMPLATE="${APPHUB_TEMPLATE:?}"
ENTRY="${APPHUB_ENTRY:-app.py}"
CMD_OVERRIDE="${APPHUB_COMMAND:-}"        # for batch jobs
IMG_DIR="${APPHUB_IMAGE_DIR:?}"
WS="${APPHUB_WORKSPACE:-$HOME}"           # user's locker by default

SING="$(command -v singularity || command -v apptainer || true)"
[[ -n "$SING" ]] || { echo "no singularity/apptainer on $(hostname)"; exit 70; }

# Persistent pip wheel cache on the NAS (shared, sticky world-writable). The first launch of
# an app that pip-installs (streamlit/fastapi) populates it; later launches reuse the cached
# wheels instead of re-downloading/rebuilding — cutting the "long wait" on repeat launches.
PIPCACHE="${APPHUB_PIP_CACHE:-$IMG_DIR/pipcache}"
mkdir -p "$PIPCACHE" 2>/dev/null || true

img() { echo "$IMG_DIR/$1"; }
# Per-template extra bind mounts (e.g. the shared conda pool for jupyterlab). Cases append to
# this before calling run(); expanded set-u-safely so an empty array passes no stray arg.
EXTRA_BINDS=()
# Workspace bind: SRC (host path) -> DST (path in container), and WS_PWD (chdir). Defaults give the
# python apps the clean /workspace abstraction. jupyter/rstudio override these to bind the WHOLE
# lockers tree at its real path (so users can reach other lockers they're permitted to — 0775 +
# sisp-group perms enforce who can read what) and chdir into the user's own locker, so pwd/HOME
# match jupyter.sisp.com.
LOCKERS_ROOT="${APPHUB_LOCKERS_ROOT:-/mnt/sisplockers}"
WS_SRC="${WS_SRC:-$WS}"; WS_DST="${WS_DST:-/workspace}"; WS_PWD="${WS_PWD:-/workspace}"
# Bind EVERY Infortrend (NAS) share mounted under /mnt into interactive apps, at the same real path
# (so paths match node1 + the MapDrive gateway). OS perms enforce who can actually read/write each
# one. Auto-detected from /proc/mounts so it stays in sync with whatever the nodes mount — no list
# to maintain. Excludes the lockers tree (bound separately) + the galaxy app-data share.
# (`if`, not an `&&`-chain, so an empty result can't trip the runner's set -e and abort the launch.)
bind_data_shares() {
  local mp
  while read -r mp; do
    case "$mp" in /mnt/sisplockers|/mnt/sisplockers/*|/mnt/galaxy-app) continue;; esac
    if [[ -d "$mp" ]]; then EXTRA_BINDS+=(--bind "$mp:$mp"); fi
  done < <(awk '$1 ~ /192\.168\.0\.103/ && $2 ~ /^\/mnt\//{print $2}' /proc/mounts | sort -u)
}
# --containall isolates; bind the workspace + the shared pip cache; run there.
run() {
  local image="$1" inner="$2"
  [[ -f "$image" ]] || { echo "image missing: $image"; exit 71; }
  # Pass the pip cache into the container via the SINGULARITYENV_/APPTAINERENV_ prefixes
  # (portable across ALL singularity/apptainer versions; the --env flag is NOT supported by
  # the older singularity on some compute nodes and breaks the exec there).
  export SINGULARITYENV_PIP_CACHE_DIR=/pipcache APPTAINERENV_PIP_CACHE_DIR=/pipcache
  export SINGULARITYENV_PIP_DISABLE_PIP_VERSION_CHECK=1 APPTAINERENV_PIP_DISABLE_PIP_VERSION_CHECK=1
  # Built-in images use a bash login shell. Bring-your-own containers (RUN_SH=1) may be minimal
  # images (alpine/busybox) with no bash, so use POSIX sh there for portability.
  local -a SHCMD=(bash -lc)
  [[ -n "${RUN_SH:-}" ]] && SHCMD=(sh -c)
  # NB: apptainer injects the calling LDAP user's passwd entry even under --containall, so the
  # real username/uid/home resolve inside the container (used by rserver's --server-user).
  exec "$SING" exec --containall --writable-tmpfs \
    --bind "$WS_SRC:$WS_DST" --bind "$PIPCACHE:/pipcache" \
    ${EXTRA_BINDS[@]+"${EXTRA_BINDS[@]}"} \
    --pwd "$WS_PWD" "$image" "${SHCMD[@]}" "$inner"
}

case "$TEMPLATE" in
  batch-job)
    run "$(img python-apps.sif)" "${CMD_OVERRIDE:?batch command required}" ;;
  nextflow)
    # Nextflow pipeline run. The DRIVER runs on the HOST (not in a container): it needs the
    # shared nextflow conda env plus the node's own singularity to pull/run each pipeline
    # process container. The full `nextflow run ...` command is built by the backend and
    # passed via APPHUB_COMMAND. The job's SLURM allocation bounds the work (executor=local).
    exec bash -c "${CMD_OVERRIDE:?nextflow command required}" ;;
  custom-app)
    # Bring-your-own-container web app. ENTRY is the user's .sif (locker-relative); CMD_OVERRIDE is
    # their start command, which must listen on $PORT. Expose PORT inside the container so the
    # command can reference it (e.g. "python -m http.server $PORT --bind 0.0.0.0"). The locker is
    # bound at /workspace; data shares are mounted too. Runs as the user, --containall isolated.
    CIMG="$WS/$ENTRY"
    [[ -f "$CIMG" ]] || { echo "container image not found: $CIMG"; exit 71; }
    bind_data_shares
    export SINGULARITYENV_PORT="$PORT" APPTAINERENV_PORT="$PORT"
    RUN_SH=1; run "$CIMG" "${CMD_OVERRIDE:?start command required}" ;;
  custom-batch)
    # Bring-your-own-container batch job. ENTRY is the user's .sif; CMD_OVERRIDE runs and exits.
    # No web port. Output goes to the locker (/workspace) and the SLURM job log.
    CIMG="$WS/$ENTRY"
    [[ -f "$CIMG" ]] || { echo "container image not found: $CIMG"; exit 71; }
    bind_data_shares
    RUN_SH=1; run "$CIMG" "${CMD_OVERRIDE:?command required}" ;;
  static-html)
    run "$(img python-apps.sif)" "python -m http.server ${PORT} --bind 0.0.0.0 --directory /workspace" ;;
  streamlit)
    run "$(img python-apps.sif)" "pip install -q streamlit 2>/dev/null; streamlit run ${ENTRY} --server.address=0.0.0.0 --server.port=${PORT} --server.headless=true" ;;
  gradio)
    run "$(img python-apps.sif)" "GRADIO_SERVER_NAME=0.0.0.0 GRADIO_SERVER_PORT=${PORT} python ${ENTRY}" ;;
  fastapi)
    run "$(img python-apps.sif)" "pip install -q uvicorn fastapi 2>/dev/null; uvicorn ${ENTRY} --host 0.0.0.0 --port ${PORT}" ;;
  jupyterlab)
    # Conda kernels: bind the shared admin env pool (read-only) at the SAME path it was created
    # under (/opt/shared-conda) so env prefixes match and relocate cleanly. The user's personal
    # envs live in /workspace/.conda/envs (persistent in their locker). nb_conda_kernels shows
    # both as clickable launcher kernels; the helper on PATH lets users create their own.
    SHARED_CONDA="${APPHUB_SHARED_CONDA:-/mnt/sisplockers/.apphub-conda}"
    [[ -d "$SHARED_CONDA/envs" ]] && EXTRA_BINDS+=(--bind "$SHARED_CONDA:/opt/shared-conda:ro")
    # Cross-folder access: bind the whole lockers tree (reach other lockers per perms) + data shares.
    WS_SRC="$LOCKERS_ROOT"; WS_DST="$LOCKERS_ROOT"; WS_PWD="$WS"; bind_data_shares
    # Mount the locker at its REAL path so the terminal's `pwd`/HOME match jupyter.sisp.com
    # (e.g. /mnt/sisplockers/<user>), and personal conda envs sit at ~/.conda/envs exactly as on
    # the main hub. disable_check_xsrf + allow_origin/remote_access: the app sits behind the
    # nginx+Authelia per-instance vhost where Jupyter's same-origin XSRF check rejects POSTs;
    # the edge is already SSO-gated, so this is safe.
    # SHELL + terminado login shell so the in-app Terminal behaves like the one on jupyter.sisp.com:
    # a login+interactive bash that sources the user's ~/.bash_profile/.profile/.bashrc from the
    # locker (HOME=$WS). USER/LOGNAME set so the prompt + tools show the real username.
    run "$(img jupyterlab.sif)" "
      export HOME=$WS USER=\$(id -un) LOGNAME=\$(id -un) SHELL=/bin/bash PATH=/opt/conda/bin:/opt/shared-conda/bin:\$PATH
      mkdir -p $WS/.conda/envs $WS/.conda/pkgs
      printf 'channels:\n  - conda-forge\nenvs_dirs:\n  - $WS/.conda/envs\n  - /opt/shared-conda/envs\npkgs_dirs:\n  - $WS/.conda/pkgs\n' > $WS/.condarc
      export CONDA_ENVS_DIRS=$WS/.conda/envs:/opt/shared-conda/envs CONDA_PKGS_DIRS=$WS/.conda/pkgs
      bash /opt/shared-conda/bin/apphub-gen-kernels $WS 2>/dev/null || true
      exec jupyter lab --ip=0.0.0.0 --port=${PORT} --no-browser --ServerApp.base_url=/ --ServerApp.token='' --ServerApp.password='' --ServerApp.disable_check_xsrf=True --ServerApp.allow_origin='*' --ServerApp.allow_remote_access=True --ServerApp.trust_xheaders=True --ServerApp.kernel_spec_manager_class=jupyter_client.kernelspec.KernelSpecManager --ServerApp.root_dir=/ --ServerApp.preferred_dir=$WS --ServerApp.terminado_settings='{\"shell_command\": [\"/bin/bash\", \"--rcfile\", \"/opt/shared-conda/bin/apphub-term-rc\"]}'
    " ;;
  rstudio|rstudio-seurat)
    # Rootless rserver behind the proxy. Hard-won details:
    #  - auth-none uses USER/LOGNAME for the signed-in identity; under --containall those are empty
    #    -> empty user -> malformed cookie -> infinite / <-> /auth-sign-in loop. Set them.
    #  - DON'T mask /etc/rstudio (keep the image's rserver.conf=rsession-which-r, themes, fonts);
    #    only single-file-bind a *readable* database.conf (the image's is mode 600, not ours to read)
    #    pointing sqlite at a writable bind. The older compute-node singularity can't create files in
    #    the container's /etc, so write configs on the host and bind them.
    #  - bind a writable whole /run + /var/lib/rstudio-server (rocker-on-singularity pattern).
    #  - HOME + server-data-dir + secure-cookie key live in the locker, so the R session, .RData and
    #    open files PERSIST and auto-restore on the next launch (survives the time limit / restart).
    #  - --www-verify-user-agent=0 avoids the /unsupported_browser.htm redirect for odd UAs.
    RU="$(id -un)"; RUID="$(id -u)"; RGID="$(id -g)"
    # Cross-folder access: bind the whole lockers tree (reach other lockers per perms) + data shares.
    WS_SRC="$LOCKERS_ROOT"; WS_DST="$LOCKERS_ROOT"; WS_PWD="$WS"; bind_data_shares
    # Conda in the RStudio Terminal too: bind the shared env pool (read-only) at /opt/shared-conda so
    # `conda activate <env>` resolves like JupyterLab. The conda *tool* comes from the image's
    # /opt/miniconda3 -> NFS-miniforge symlink (baked), reachable via the lockers-tree bind.
    SHARED_CONDA="${APPHUB_SHARED_CONDA:-/mnt/sisplockers/.apphub-conda}"
    if [[ -d "$SHARED_CONDA/envs" ]]; then EXTRA_BINDS+=(--bind "$SHARED_CONDA:/opt/shared-conda:ro"); fi
    RSRUN="$(mktemp -d "${TMPDIR:-/tmp}/apphub-rs.XXXXXX")"; mkdir -p "$RSRUN/varlib" "$RSRUN/run"
    printf 'provider=sqlite\ndirectory=/var/lib/rstudio-server\n' > "$RSRUN/database.conf"
    EXTRA_BINDS+=(--bind "$RSRUN/varlib:/var/lib/rstudio-server" --bind "$RSRUN/run:/run" --bind "$RSRUN/database.conf:/etc/rstudio/database.conf")
    # rstudio-seurat gets the Seurat-laden image; fall back to plain rstudio until it's built so a
    # launch never hard-fails on "image missing".
    RIMG=rstudio.sif
    if [[ "$TEMPLATE" == "rstudio-seurat" && -f "$IMG_DIR/rstudio-seurat.sif" ]]; then RIMG=rstudio-seurat.sif; fi
    run "$(img "$RIMG")" "
      export HOME=$WS USER=$RU LOGNAME=$RU
      getent passwd $RU >/dev/null 2>&1 || grep -q '^$RU:' /etc/passwd || echo '$RU:x:$RUID:$RGID::$WS:/bin/bash' >> /etc/passwd
      mkdir -p $WS/.rstudio $WS/.conda/envs $WS/.conda/pkgs
      printf 'channels:\n  - conda-forge\nenvs_dirs:\n  - $WS/.conda/envs\n  - /opt/shared-conda/envs\npkgs_dirs:\n  - $WS/.conda/pkgs\n' > $WS/.condarc
      exec rserver --www-address=0.0.0.0 --www-port=${PORT} --auth-none=1 --rsession-which-r=/usr/local/bin/R --www-verify-user-agent=0 --server-user=$RU --server-daemonize=0 --database-config-file=/etc/rstudio/database.conf --server-data-dir=$WS/.rstudio --secure-cookie-key-file=$WS/.rstudio/cookie
    " ;;
  *)
    echo "unknown template: ${TEMPLATE}" >&2; exit 64 ;;
esac
