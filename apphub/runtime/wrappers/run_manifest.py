#!/usr/bin/env python3
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path


def fail(message: str, code: int = 1) -> None:
    print(f"apphub-runner: {message}", file=sys.stderr)
    raise SystemExit(code)


def write_status(manifest, state, extra=None):
    log_dir = Path(manifest.get("logDir") or ".")
    status_path = log_dir / "runner-status.json"
    payload = {
        "appId": manifest.get("appId"),
        "state": state,
        "host": socket.getfqdn(),
        "port": manifest.get("port"),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if extra:
        payload.update(extra)
    status_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.chmod(status_path, 0o664)


def apptainer_command(manifest, command):
    image = manifest.get("image")
    if not image:
        return command
    apptainer = shutil.which("apptainer") or shutil.which("singularity")
    if not apptainer:
        fail("Apptainer/Singularity is required for this template but is not installed on this node.", 69)
    if not Path(image).exists():
        fail(f"container image does not exist: {image}", 66)

    args = [apptainer, "exec", "--cleanenv"]
    for key, value in (manifest.get("environment") or {}).items():
      args.extend(["--env", f"{key}={value}"])
    for volume in manifest.get("volumes") or []:
        source = volume.get("source")
        target = volume.get("target")
        mode = volume.get("mode", "rw")
        if source and target:
            args.extend(["--bind", f"{source}:{target}:{mode}"])
    workdir = manifest.get("workingDirectory")
    if workdir:
        args.extend(["--pwd", workdir])
    args.append(image)
    args.extend(command)
    return args


def main() -> int:
    manifest_path = Path(sys.argv[1])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    command = manifest.get("command")
    if not isinstance(command, list) or not command:
        fail("manifest command must be a non-empty array", 65)

    log_dir = Path(manifest.get("logDir") or ".")
    log_dir.mkdir(parents=True, exist_ok=True)
    workspace = manifest.get("workspacePath")
    if workspace:
        Path(workspace).mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    for key, value in (manifest.get("environment") or {}).items():
        env[str(key)] = str(value)
    env["APPHUB_APP_ID"] = str(manifest.get("appId", ""))
    env["APPHUB_PORT"] = str(manifest.get("port", ""))

    final_command = apptainer_command(manifest, [str(item) for item in command])
    print("apphub-runner: starting", " ".join(final_command), flush=True)
    write_status(manifest, "running", {"command": final_command[:4]})
    process = subprocess.Popen(final_command, env=env)
    code = process.wait()
    write_status(manifest, "exited", {"exitCode": code})
    return code


if __name__ == "__main__":
    raise SystemExit(main())
