import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { renderTemplate } from "./templates.js";

function nowIso() {
  return new Date().toISOString();
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with code ${code}`), { stdout, stderr, code }));
    });
  });
}

function runPrivilegedWrapper(wrapper, args, options = {}) {
  return run("sudo", ["-n", wrapper, ...args], options);
}

function isMissingSlurmJobError(error) {
  const text = `${error?.message || ""}\n${error?.stderr || ""}`;
  return /Invalid job id specified|slurm_load_jobs error/i.test(text);
}

function slurmTime(minutes) {
  const total = Math.max(1, Number(minutes) || 1);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${hours}:${String(mins).padStart(2, "0")}:00`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveImage(config, template) {
  if (!template.image) return "";
  if (path.isAbsolute(template.image)) return template.image;
  return path.posix.join(config.imageRoot.replace(/\\/g, "/"), template.image);
}

export function buildManifest(config, app, template) {
  const homePath = path.posix.join(config.homeBase, app.owner);
  const context = {
    appId: app.id,
    user: app.owner,
    port: app.port,
    workspace: app.workspacePath,
    home: homePath,
    entrypoint: app.entrypoint || template.defaultEntrypoint || "app.py"
  };
  const rendered = renderTemplate(template, context);
  return {
    schemaVersion: 1,
    appId: app.id,
    appName: app.name,
    owner: app.owner,
    templateId: template.id,
    port: app.port,
    workspacePath: app.workspacePath,
    logDir: app.logDir,
    image: resolveImage(config, template),
    command: rendered.command,
    environment: rendered.environment,
    volumes: rendered.volumes,
    workingDirectory: rendered.workingDirectory,
    createdAt: nowIso()
  };
}

function buildJobScript(config, app, manifestPath, statusPath) {
  const lines = [
    "#!/usr/bin/env bash",
    `#SBATCH --job-name=${app.slurmName}`,
    `#SBATCH --cpus-per-task=${app.cpus}`,
    `#SBATCH --mem=${app.memoryMb}M`,
    `#SBATCH --output=${path.posix.join(app.logDir, "stdout.log")}`,
    `#SBATCH --error=${path.posix.join(app.logDir, "stderr.log")}`,
    "#SBATCH --nodes=1",
    "#SBATCH --chdir=/tmp"
  ];
  if (Number(app.timeLimitMinutes) > 0) lines.splice(4, 0, `#SBATCH --time=${slurmTime(app.timeLimitMinutes)}`);
  if (config.slurmPartition) lines.push(`#SBATCH --partition=${config.slurmPartition}`);
  if (Array.isArray(app.allowedNodes) && app.allowedNodes.length) {
    const allowed = new Set(app.allowedNodes);
    const excluded = (config.clusterNodes || []).filter((node) => !allowed.has(node));
    if (excluded.length) lines.push(`#SBATCH --exclude=${excluded.join(",")}`);
  }
  lines.push(
    "",
    "set -euo pipefail",
    "umask 0002",
    `mkdir -p ${shellQuote(app.logDir)}`,
    "APPHUB_HOSTNAME=$(hostname -f 2>/dev/null || hostname)",
    "python3 - \"$APPHUB_HOSTNAME\" \"$SLURM_JOB_ID\" <<'PY'",
    "import json, os, sys, time",
    "host, job_id = sys.argv[1], sys.argv[2]",
    `status_path = ${JSON.stringify(statusPath)}`,
    "with open(status_path, 'w', encoding='utf-8') as handle:",
    "    json.dump({'host': host, 'jobId': job_id, 'state': 'starting', 'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}, handle)",
    "os.chmod(status_path, 0o664)",
    "PY",
    `exec ${shellQuote(config.runnerPath)} ${shellQuote(manifestPath)}`
  );
  return `${lines.join("\n")}\n`;
}

export class SlurmClient {
  constructor(config) {
    this.config = config;
  }

  async launch(app, template) {
    if (this.config.slurmMode === "mock") {
      return {
        slurmJobId: `mock-${randomUUID().slice(0, 8)}`,
        status: "running",
        targetHost: "127.0.0.1",
        node: "local",
        startedAt: nowIso()
      };
    }

    const appJobRoot = path.join(this.config.jobRoot, app.id);
    await mkdir(appJobRoot, { recursive: true });
    await mkdir(app.logDir, { recursive: true });
    await chmod(appJobRoot, 0o2775).catch(() => {});
    await chmod(app.logDir, 0o2775).catch(() => {});
    const manifestPath = path.join(appJobRoot, "manifest.json");
    const statusPath = path.join(appJobRoot, "status.json");
    const scriptPath = path.join(appJobRoot, "job.sh");
    const manifest = buildManifest(this.config, app, template);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await writeFile(scriptPath, buildJobScript(this.config, app, manifestPath, statusPath), "utf8");
    await chmod(scriptPath, 0o750);

    const { stdout } = await runPrivilegedWrapper(this.config.sbatchWrapper, ["submit", app.owner, scriptPath], {
      env: { APPHUB_JOB_ROOT: this.config.jobRoot }
    });
    const jobId = stdout.trim().split(/\s+/)[0];
    if (!jobId) throw new Error("Slurm did not return a job id.");
    return {
      slurmJobId: jobId,
      status: "queued",
      statusPath,
      manifestPath
    };
  }

  async cancel(app) {
    if (!app?.slurmJobId) return;
    if (this.config.slurmMode === "mock") return;
    try {
      await runPrivilegedWrapper(this.config.scancelWrapper, ["cancel", app.owner, String(app.slurmJobId)], {
        env: { APPHUB_JOB_ROOT: this.config.jobRoot }
      });
    } catch (error) {
      if (!isMissingSlurmJobError(error)) throw error;
    }
  }

  async readJobStatus(app) {
    if (this.config.slurmMode === "mock") {
      return app.status === "running" ? { state: "RUNNING", node: app.node || "local" } : null;
    }
    let runnerStatus = null;
    const runnerStatusPath = app.logDir ? path.join(app.logDir, "runner-status.json") : "";
    if (runnerStatusPath) {
      try {
        runnerStatus = JSON.parse(await readFile(runnerStatusPath, "utf8"));
        if (runnerStatus.state === "exited") {
          return {
            state: Number(runnerStatus.exitCode) === 0 ? "COMPLETED" : "FAILED",
            host: runnerStatus.host,
            jobId: runnerStatus.jobId,
            error: `Runner exited with code ${runnerStatus.exitCode}`
          };
        }
      } catch {
        // The runner writes this only after the application process starts.
      }
    }

    let fileStatus = null;
    if (app.statusPath) {
      try {
        const status = JSON.parse(await readFile(app.statusPath, "utf8"));
        fileStatus = { state: status.state || "STARTING", host: status.host, jobId: status.jobId };
      } catch {
        // The job may still be queued and not have written its status file.
      }
    }
    if (!app.slurmJobId) return null;
    try {
      const { stdout } = await run("squeue", ["-h", "-j", String(app.slurmJobId), "-o", "%T|%N"]);
      const line = stdout.trim().split(/\r?\n/)[0];
      if (!line) {
        try {
          const { stdout: jobDetails } = await run("scontrol", ["show", "job", String(app.slurmJobId)]);
          const state = jobDetails.match(/\bJobState=([A-Z_]+)/)?.[1] || "COMPLETED";
          return { ...(fileStatus || {}), host: runnerStatus?.host || fileStatus?.host, state };
        } catch (error) {
          if (isMissingSlurmJobError(error)) {
            return {
              ...(fileStatus || {}),
              host: runnerStatus?.host || fileStatus?.host,
              state: "FAILED",
              error: `Slurm job ${app.slurmJobId} is no longer active.`
            };
          }
          throw error;
        }
      }
      const [state, node] = line.split("|");
      return { ...(fileStatus || {}), state, node, host: runnerStatus?.host || fileStatus?.host };
    } catch (error) {
      if (isMissingSlurmJobError(error)) {
        return {
          ...(fileStatus || {}),
          host: runnerStatus?.host || fileStatus?.host,
          state: "FAILED",
          error: `Slurm job ${app.slurmJobId} is no longer active.`
        };
      }
      if (fileStatus) return fileStatus;
      return { state: "UNKNOWN", error: error.message };
    }
  }
}
