#!/usr/bin/env bash
# ============================================================================
# Build the AppHub container images onto the shared NAS image dir so the catalog's
# notebook/RStudio templates launch and the python apps have no runtime pip wait.
# Run on a compute node that has singularity + internet (fakeroot or root).
#
#   sudo bash build-images.sh            # builds all three
#   sudo bash build-images.sh jupyterlab # build just one
#
# Output dir is the shared NAS image dir the runner reads (APPHUB_IMAGE_DIR).
# These are large (multi-GB) and take 10-30 min each; run in tmux/screen.
# ============================================================================
set -Eeuo pipefail
IMG_DIR="${APPHUB_IMAGE_DIR:-/mnt/sisplockers/.apphub-images}"
SING="$(command -v singularity || command -v apptainer)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
# Atomic: build to a temp then move into place, so a failed build never corrupts a
# working image (e.g. the live python-apps.sif that static-html/streamlit depend on).
build() {
  local out="$1" def="$2"
  local tmp="$IMG_DIR/.build-${out}.$$"
  echo "==> building $out (-> temp, atomic move on success)"
  if "$SING" build --fakeroot "$tmp" "$def" || "$SING" build "$tmp" "$def"; then
    mv -f "$tmp" "$IMG_DIR/$out"; echo "  done: $(ls -lh "$IMG_DIR/$out" | awk '{print $5}')"
  else echo "  FAILED — left existing $out untouched"; rm -f "$tmp"; return 1; fi
}
want() { [ $# -eq 1 ] && return 0; shift; for a in "$@"; do [ "$a" = "$TARGET" ] && return 0; done; return 1; }
TARGET="${1:-all}"

# ---- python-apps.sif: static/streamlit/gradio/fastapi/batch, packages pre-baked ----
if [ "$TARGET" = all ] || [ "$TARGET" = python-apps ]; then
cat > "$WORK/python-apps.def" <<'DEF'
Bootstrap: docker
From: python:3.11-slim
%post
    pip install --no-cache-dir streamlit gradio "fastapi[standard]" "uvicorn[standard]" \
        pandas numpy matplotlib requests
    python -c "import streamlit, gradio, fastapi, uvicorn, http.server"
%runscript
    exec "$@"
DEF
build python-apps.sif "$WORK/python-apps.def"
fi

# ---- jupyterlab.sif: miniforge base so it can DISCOVER external conda envs as kernels ----
# The base env is the fast "launcher" Jupyter (local to the image). nb_conda_kernels lets it
# show every env in CONDA_ENVS_DIRS (the user's personal envs in /workspace + the shared admin
# pool on NFS) as clickable kernels, with ipywidgets working in each. conda+mamba are present
# so users can create their own envs from the in-app terminal (see apphub-conda helper).
if [ "$TARGET" = all ] || [ "$TARGET" = jupyterlab ]; then
cat > "$WORK/jupyterlab.def" <<'DEF'
Bootstrap: docker
From: condaforge/miniforge3:latest
%post
    # ipywidgets pulls jupyterlab_widgets in automatically; harmonypy isn't on conda-forge → pip.
    mamba install -y -n base -c conda-forge \
        jupyterlab notebook ipywidgets ipympl nb_conda_kernels \
        numpy pandas scipy scikit-learn matplotlib seaborn \
        scanpy anndata leidenalg
    /opt/conda/bin/pip install --no-cache-dir harmonypy
    # Users' ~/.bashrc (shared with jupyter.sisp.com) does `source /opt/miniconda3/bin/activate;
    # conda activate python3`. Make that legacy path resolve to this image's conda so the in-app
    # Terminal initialises conda exactly like the main hub (prompt: (python3) user@host:~$) instead
    # of erroring with "/opt/miniconda3/bin/activate: No such file or directory".
    ln -sfn /opt/conda /opt/miniconda3
    conda clean -afy
    /opt/conda/bin/jupyter lab --version
    /opt/conda/bin/python -c "import ipywidgets, nb_conda_kernels, scanpy, harmonypy; print('ipywidgets', ipywidgets.__version__)"
%environment
    export PATH=/opt/conda/bin:$PATH
%runscript
    exec "$@"
DEF
build jupyterlab.sif "$WORK/jupyterlab.def"
fi

# ---- rstudio.sif: plain RStudio Server (template: rstudio) ----
# rserver runs unprivileged with --auth-none=1 (the runner passes that). The /opt/miniconda3
# symlink -> the NFS miniforge (reachable via the lockers-tree bind) gives the RStudio Terminal
# conda exactly like the main hub (users' ~/.bashrc does `source /opt/miniconda3/bin/activate`).
if [ "$TARGET" = all ] || [ "$TARGET" = rstudio ]; then
cat > "$WORK/rstudio.def" <<'DEF'
Bootstrap: docker
From: rocker/rstudio:4.4.1
%post
    ln -sfn /mnt/sisplockers/.apphub-conda/base /opt/miniconda3
%runscript
    exec "$@"
DEF
  echo "==> building rstudio.sif from rocker/rstudio (large)"
  rtmp="$IMG_DIR/.build-rstudio.sif.$$"
  if "$SING" build --fakeroot "$rtmp" "$WORK/rstudio.def" || "$SING" build "$rtmp" "$WORK/rstudio.def"; then
    mv -f "$rtmp" "$IMG_DIR/rstudio.sif"; echo "  done: $(ls -lh "$IMG_DIR/rstudio.sif" | awk '{print $5}')"
  else echo "  FAILED"; rm -f "$rtmp"; fi
fi

# ---- rstudio-seurat.sif: RStudio + Seurat single-cell stack (template: rstudio-seurat) ----
# Seurat pulls a large compiled dependency tree; this build is SLOW (30-60+ min). Built separately
# so the plain rstudio image stays lean. The runner points rstudio-seurat at this image.
if [ "$TARGET" = all ] || [ "$TARGET" = rstudio-seurat ]; then
cat > "$WORK/rstudio-seurat.def" <<'DEF'
Bootstrap: docker
From: rocker/rstudio:4.4.1
%post
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
        cmake libhdf5-dev libcurl4-openssl-dev libssl-dev libxml2-dev libpng-dev libjpeg-dev \
        libtiff5-dev libgeos-dev libglpk-dev libgsl-dev libfftw3-dev \
        libfontconfig1-dev libharfbuzz-dev libfribidi-dev libfreetype6-dev \
        libuv1-dev libgit2-dev libsodium-dev libudunits2-dev zlib1g-dev libbz2-dev liblzma-dev
    R -e "install.packages(c('Seurat','harmony','remotes','BiocManager'), repos='https://cloud.r-project.org')"
    R -e "if(!requireNamespace('Seurat',quietly=TRUE)) quit(status=1)"
    R -e "remotes::install_github('immunogenomics/presto')" || echo 'presto optional - skipped'
    R -e "library(Seurat); cat('Seurat', as.character(packageVersion('Seurat')), 'OK\n')"
    ln -sfn /mnt/sisplockers/.apphub-conda/base /opt/miniconda3
%runscript
    exec "$@"
DEF
  echo "==> building rstudio-seurat.sif (Seurat — SLOW, 30-60+ min)"
  stmp="$IMG_DIR/.build-rstudio-seurat.sif.$$"
  if "$SING" build --fakeroot "$stmp" "$WORK/rstudio-seurat.def" || "$SING" build "$stmp" "$WORK/rstudio-seurat.def"; then
    mv -f "$stmp" "$IMG_DIR/rstudio-seurat.sif"; echo "  done: $(ls -lh "$IMG_DIR/rstudio-seurat.sif" | awk '{print $5}')"
  else echo "  FAILED — left existing untouched"; rm -f "$stmp"; fi
fi

echo
echo "Images in $IMG_DIR:"; ls -lh "$IMG_DIR"/*.sif 2>/dev/null
echo "Verify by launching each template from the AppHub catalog; check the Job Queue + logs."
