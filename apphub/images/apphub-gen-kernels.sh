#!/bin/bash
# apphub-gen-kernels — generate short, readable Jupyter kernelspecs for the shared admin
# conda envs and the user's personal envs, replacing nb_conda_kernels' verbose
# "Python [conda env:shared-conda-<env>]" labels with "shared-<env>" / "<env> (mine)".
#
# Runs INSIDE the jupyterlab container at launch (the runner calls it). The shared pool is
# bound read-only at /opt/shared-conda; the user's locker is HOME ($1). Kernels start via
# `conda run -p <prefix>` so each env's activation (PATH, env vars) is applied — same as
# nb_conda_kernels, just with clean names we control.
set -u
WS="${1:-$HOME}"
CONDA=/opt/conda/bin/conda
KROOT="$WS/.local/share/jupyter/kernels"
mkdir -p "$KROOT"

# Clear our previously-generated specs so renamed/removed envs don't linger across launches.
rm -rf "$KROOT"/shared-* "$KROOT"/my-* 2>/dev/null || true

gen() { # $1=env prefix  $2=spec dir name  $3=display name
  local p="$1" nm="$2" dn="$3" dir="$KROOT/$2"
  # Fast filesystem checks (no python/R startup — those are slow over NFS and would add
  # tens of seconds to every launch with several envs).
  if [ -x "$p/bin/python" ] && ls -d "$p"/lib/python*/site-packages/ipykernel >/dev/null 2>&1; then
    mkdir -p "$dir"
    printf '{"argv":["%s","run","--no-capture-output","-p","%s","python","-m","ipykernel_launcher","-f","{connection_file}"],"display_name":"%s","language":"python"}\n' \
      "$CONDA" "$p" "$dn" > "$dir/kernel.json"
  elif [ -d "$p/lib/R/library/IRkernel" ]; then
    mkdir -p "$dir"
    printf '{"argv":["%s","run","--no-capture-output","-p","%s","R","--slave","-e","IRkernel::main()","--args","{connection_file}"],"display_name":"%s","language":"R"}\n' \
      "$CONDA" "$p" "$dn" > "$dir/kernel.json"
  fi
}

# Shared admin envs -> shown by their plain name (e.g. "python3"). The spec dir keeps a
# "shared-" prefix so its internal id stays unique and never clashes with a personal env.
for e in /opt/shared-conda/envs/*/; do
  [ -d "$e" ] || continue
  n="$(basename "${e%/}")"
  gen "${e%/}" "shared-$n" "$n"
done

# User's personal envs -> "<env> (mine)"
for e in "$WS"/.conda/envs/*/; do
  [ -d "$e" ] || continue
  n="$(basename "${e%/}")"
  gen "${e%/}" "my-$n" "$n (mine)"
done
