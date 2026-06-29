#!/usr/bin/env bash
set -euo pipefail

image_root="${APPHUB_IMAGE_ROOT:-/mnt/sisplockers/apphub/images}"
nodes="${APPHUB_PREWARM_NODES:-node2,node3,node4}"
images="${APPHUB_PREWARM_IMAGES:-python-apps.sif,jupyterlab.sif,rstudio.sif,galaxy-tool-dev.sif}"

IFS=',' read -r -a node_list <<< "$nodes"
IFS=',' read -r -a image_list <<< "$images"

for node in "${node_list[@]}"; do
  for image in "${image_list[@]}"; do
    path="$image_root/$image"
    if [ ! -r "$path" ]; then
      echo "skip missing $path"
      continue
    fi
    echo "prewarm $node $image"
    srun -N1 -n1 -w "$node" --time=00:02:00 bash -lc "command -v apptainer >/dev/null && apptainer exec '$path' true || singularity exec '$path' true"
  done
done
