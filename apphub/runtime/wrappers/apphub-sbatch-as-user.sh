#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: apphub-sbatch-as-user.sh submit USER JOB_SCRIPT" >&2
  echo "       apphub-sbatch-as-user.sh cancel USER JOB_ID" >&2
  exit 64
}

if [ "$#" -lt 3 ]; then
  usage
fi

action="$1"
target_user="$2"
target="$3"
job_root="${APPHUB_JOB_ROOT:-/mnt/sisplockers/apphub/jobs}"
preferred_gid="${APPHUB_PREFERRED_GID:-100000}"
preferred_uid_min="${APPHUB_PREFERRED_UID_MIN:-10000}"
shared_home_base="${APPHUB_SHARED_HOME_BASE:-/mnt/sisplockers}"
workspace_base="${APPHUB_WORKSPACE_BASE:-/mnt/sisplockers/apphub/workspaces}"

case "$target_user" in
  ""|*[!a-zA-Z0-9_.-]*)
    echo "invalid target user" >&2
    exit 65
    ;;
esac

passwd_entries="$(getent passwd "$target_user" || true)"
if [ -z "$passwd_entries" ]; then
  echo "target user does not exist: $target_user" >&2
  exit 67
fi

is_numeric() {
  case "$1" in
    ""|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

entry_for_uid_if_matching_user() {
  candidate_uid="$1"
  if ! is_numeric "$candidate_uid"; then
    return 1
  fi
  candidate_entry="$(getent passwd "$candidate_uid" || true)"
  if [ -z "$candidate_entry" ]; then
    return 1
  fi
  candidate_name="$(printf '%s\n' "$candidate_entry" | cut -d: -f1)"
  if [ "$candidate_name" = "$target_user" ]; then
    printf '%s\n' "$candidate_entry"
    return 0
  fi
  return 1
}

entry_from_owned_path() {
  for candidate_path in "$workspace_base/$target_user" "$shared_home_base/$target_user"; do
    [ -e "$candidate_path" ] || continue
    candidate_uid="$(stat -c '%u' "$candidate_path" 2>/dev/null || true)"
    candidate_gid="$(stat -c '%g' "$candidate_path" 2>/dev/null || true)"
    is_numeric "$candidate_uid" || continue
    is_numeric "$candidate_gid" || continue
    if [ "$candidate_uid" -ge "$preferred_uid_min" ] || [ "$candidate_gid" = "$preferred_gid" ]; then
      entry_for_uid_if_matching_user "$candidate_uid" && return 0
    fi
  done
  return 1
}

target_entry="$(
  printf '%s\n' "$passwd_entries" | awk -F: -v preferred_gid="$preferred_gid" -v preferred_uid_min="$preferred_uid_min" '
    $4 == preferred_gid || $3 >= preferred_uid_min { print; found=1; exit }
    END { if (!found) exit 1 }
  ' || true
)"
if [ -z "$target_entry" ]; then
  target_entry="$(entry_from_owned_path || true)"
fi
if [ -z "$target_entry" ]; then
  target_entry="$(printf '%s\n' "$passwd_entries" | head -n 1)"
fi
target_uid="$(printf '%s\n' "$target_entry" | cut -d: -f3)"
target_gid="$(printf '%s\n' "$target_entry" | cut -d: -f4)"

run_as_user() {
  if [ "$(id -u)" = "$target_uid" ]; then
    "$@"
  elif [ "$(id -u)" -eq 0 ]; then
    sudo -n -u "#$target_uid" -g "#$target_gid" "$@"
  else
    sudo -n -H -u "#$target_uid" -g "#$target_gid" "$@"
  fi
}

case "$action" in
  submit)
    case "$(readlink -f "$target")" in
      "$(readlink -f "$job_root")"/*) ;;
      *)
        echo "job script must be under $job_root" >&2
        exit 65
        ;;
    esac
    if [ "$(id -u)" -eq 0 ]; then
      sbatch --uid="$target_uid" --gid="$target_gid" --parsable "$target"
    else
      run_as_user sbatch --parsable "$target"
    fi
    ;;
  cancel)
    case "$target" in
      *[!0-9]*|"")
        echo "invalid job id" >&2
        exit 65
        ;;
    esac
    if [ "$(id -u)" -eq 0 ]; then
      scancel "$target"
    else
      run_as_user scancel "$target"
    fi
    ;;
  *)
    usage
    ;;
esac
