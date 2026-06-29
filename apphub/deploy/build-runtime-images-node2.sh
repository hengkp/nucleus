#!/usr/bin/env bash
set -euo pipefail

image_root="${APPHUB_IMAGE_ROOT:-/mnt/sisplockers/apphub/images}"
definition_root="${APPHUB_DEFINITION_ROOT:-/mnt/sisplockers/apphub/runtime/definitions}"
builder="${APPHUB_BUILDER:-$(command -v apptainer || command -v singularity || true)}"

if [ -z "$builder" ]; then
  echo "apptainer or singularity is required on the build node" >&2
  exit 69
fi

mkdir -p "$image_root"

build_image() {
  local name="$1"
  local definition="$definition_root/$name.def"
  local target="$image_root/$name.sif"
  local tmp="$target.tmp"

  if [ ! -r "$definition" ]; then
    echo "missing definition: $definition" >&2
    exit 66
  fi

  echo "building $target"
  "$builder" build --force "$tmp" "$definition"
  chmod 0644 "$tmp"
  mv "$tmp" "$target"
}

build_image jupyterlab
build_image rstudio
build_image galaxy-tool-dev

ls -lh "$image_root"/jupyterlab.sif "$image_root"/rstudio.sif "$image_root"/galaxy-tool-dev.sif
