#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: apphub-runner.sh MANIFEST_JSON" >&2
  exit 64
fi

manifest="$1"
if [ ! -r "$manifest" ]; then
  echo "manifest is not readable: $manifest" >&2
  exit 66
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$script_dir/run_manifest.py" "$manifest"
