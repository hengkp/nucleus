#!/usr/bin/env bash
# apphub-sbatch-as-user.sh — fail-closed wrapper that submits a SLURM job AS the
# requesting LDAP user. Invoked ONLY via a tightly-scoped sudoers rule by the apphub
# service account. This is the privilege boundary (ADR-002 / ADR-005 / RISKS #3,#4).
#
# Hard refusals (no fallbacks, ever):
#   - uid < 10000 or primary gid != 100000  (only real LDAP researchers)
#   - username not resolvable, or getent disagreement
#   - reserved/system usernames
#   - missing/invalid required args
set -Eeuo pipefail
IFS=$'\n\t'

die() { echo "apphub-wrapper: $*" >&2; exit 64; }

USER="" TEMPLATE="" CPUS="" MEM="" TIME="" PORT="" NAME="" ENTRY="" COMMAND="" FOLDER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER="${2:-}"; shift 2;;
    --template) TEMPLATE="${2:-}"; shift 2;;
    --cpus) CPUS="${2:-}"; shift 2;;
    --mem) MEM="${2:-}"; shift 2;;
    --time) TIME="${2:-}"; shift 2;;
    --port) PORT="${2:-}"; shift 2;;
    --name) NAME="${2:-}"; shift 2;;
    --entrypoint) ENTRY="${2:-}"; shift 2;;
    --command) COMMAND="${2:-}"; shift 2;;
    --folder) FOLDER="${2:-}"; shift 2;;
    *) die "unknown argument: $1";;
  esac
done
# Folder = relative subpath within the locker (no traversal).
[[ -z "$FOLDER" || ( "$FOLDER" != *..* && "$FOLDER" != /* && "$FOLDER" =~ ^[A-Za-z0-9._\ /-]{1,200}$ ) ]] || die "bad folder"

# batch jobs and nextflow runs have no web port; web apps require one.
IS_BATCH=0; [[ "$TEMPLATE" == "batch-job" || "$TEMPLATE" == "nextflow" || "$TEMPLATE" == "custom-batch" ]] && IS_BATCH=1
[[ -n "$USER" && -n "$TEMPLATE" && -n "$CPUS" && -n "$MEM" && -n "$TIME" && -n "$NAME" ]] || die "missing required argument"
[[ $IS_BATCH -eq 1 || -n "$PORT" ]] || die "missing --port"
[[ $IS_BATCH -eq 0 || -n "$COMMAND" ]] || die "batch job missing --command"

# Strict argument shapes (defense against injection into the submission).
[[ "$USER"  =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "bad username"
[[ "$TEMPLATE" =~ ^[a-z0-9-]{1,40}$ ]]      || die "bad template"
[[ "$NAME"  =~ ^[a-z0-9-]{1,40}$ ]]         || die "bad name"
[[ "$CPUS"  =~ ^[0-9]{1,3}$ ]]              || die "bad cpus"
[[ "$MEM"   =~ ^[0-9]{2,7}$ ]]              || die "bad mem"
[[ $IS_BATCH -eq 1 || "$PORT" =~ ^31[0-9]{3}$ ]] || die "bad port"   # 31000-31999, matches the allocator pool
[[ "$TIME"  =~ ^([0-9]{1,5}|UNLIMITED)$ ]] || die "bad time"
[[ -z "$ENTRY" || "$ENTRY" =~ ^[A-Za-z0-9._/:-]{1,128}$ ]] || die "bad entrypoint"
# No traversal / absolute paths in the entrypoint (relative, within the workspace).
[[ "$ENTRY" != *..* && "$ENTRY" != /* ]]   || die "entrypoint must be a relative path without '..'"

# Bring-your-own-container backends: ENTRY is the user's .sif image, locker-relative (already
# validated above), so the image is confined to files the user can already read (job runs as them).
if [[ "$TEMPLATE" == "custom-app" || "$TEMPLATE" == "custom-batch" ]]; then
  [[ -n "$ENTRY" ]]        || die "container image path required"
  [[ "$ENTRY" == *.sif ]]  || die "container image must be a .sif file"
fi

# Reserved/system accounts may never own a user job.
case "$USER" in
  root|nodeadmin|admin|daemon|bin|sys|slurm|postgres|nobody) die "reserved user: $USER";;
esac

# Resolve identity from NSS/SSSD and enforce the LDAP envelope.
PW="$(getent passwd "$USER")" || die "user not found: $USER"
UID_N="$(echo "$PW" | cut -d: -f3)"
GID_N="$(echo "$PW" | cut -d: -f4)"
HOME_DIR="$(echo "$PW" | cut -d: -f6)"
[[ "$UID_N" =~ ^[0-9]+$ ]] || die "non-numeric uid"
(( UID_N >= 10000 )) || die "uid below floor: $UID_N"
(( GID_N == 100000 )) || die "primary gid not sisp(100000): $GID_N"
[[ -n "$HOME_DIR" ]] || die "no home dir"

# Map to the cluster's REAL partitions (verified live 2026-06-27: small*/large/UNLIMITED):
# finite time -> "small" (default), unlimited -> the "UNLIMITED" partition. node1 excluded.
if [[ "$TIME" == "UNLIMITED" ]]; then SLURM_TIME="UNLIMITED"; PARTITION="UNLIMITED"; else SLURM_TIME="$TIME"; PARTITION="small"; fi

# Images live on shared NAS storage (node1 root is space-constrained). Singularity (Apptainer-
# compatible) is on the compute nodes; the runner picks it up.
IMAGE_DIR="${APPHUB_IMAGE_DIR:-/mnt/sisplockers/.apphub-images}"
# The runner executes INSIDE the job on a compute node, so it must live on shared storage
# that every node mounts (not node1-local /opt).
WRAP="${APPHUB_RUNNER:-/mnt/sisplockers/.apphub-images/bin/apphub-runner.sh}"
ESC_CMD="${COMMAND//\'/\'\\\'\'}"   # safely single-quote the batch command

# Submit AS the user, chdir'd into their locker (writable) so the job can launch + log.
# --export=NONE so the apphub account's env never leaks in; the runner re-sets PATH.
# node1 is excluded everywhere; control plane is never scheduled (ADR-002).
# Workspace = the chosen folder within the locker (default: locker root). The job runs there.
WORKSPACE="$HOME_DIR"; [[ -n "$FOLDER" ]] && WORKSPACE="$HOME_DIR/$FOLDER"

exec runuser -u "$USER" -- sbatch \
  --parsable \
  --job-name="apphub-${NAME}" \
  --partition="$PARTITION" \
  --exclude=node1 \
  --chdir="$WORKSPACE" \
  --output="$HOME_DIR/.apphub-slurm-%j.out" \
  --cpus-per-task="$CPUS" \
  --mem="${MEM}M" \
  --time="$SLURM_TIME" \
  --export=NONE \
  --wrap "APPHUB_PORT='$PORT' APPHUB_TEMPLATE='$TEMPLATE' APPHUB_ENTRY='$ENTRY' APPHUB_COMMAND='$ESC_CMD' APPHUB_WORKSPACE='$WORKSPACE' APPHUB_IMAGE_DIR='$IMAGE_DIR' '$WRAP'"
