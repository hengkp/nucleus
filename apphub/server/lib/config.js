import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, "..");
const apphubRoot = path.resolve(serverRoot, "..");

function env(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function intEnv(name, fallback) {
  const value = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

function listEnv(name, fallback = []) {
  return env(name)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .concat(fallback)
    .filter((item, index, all) => all.indexOf(item) === index);
}

function parsePortRange(value) {
  const match = String(value || "").match(/^(\d{2,5})-(\d{2,5})$/);
  if (!match) return { start: 31000, end: 31999 };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 1024 || end > 65535 || start > end) return { start: 31000, end: 31999 };
  return { start, end };
}

export function loadConfig() {
  const nodeEnv = env("NODE_ENV", "development");
  const dataDir = path.resolve(env("DATA_DIR", path.join(serverRoot, "data")));
  const slurmMode = env("APPHUB_SLURM_MODE", nodeEnv === "production" ? "slurm" : "mock");
  const appDomain = env("APPHUB_APP_DOMAIN", "app.sisp.com");
  const runtimeRoot = path.resolve(env("APPHUB_RUNTIME_ROOT", path.join(apphubRoot, "runtime")));

  return {
    nodeEnv,
    port: intEnv("PORT", 8792),
    host: env("HOST", "127.0.0.1"),
    apphubRoot,
    serverRoot,
    webRoot: path.resolve(env("WEB_ROOT", path.join(apphubRoot, "web"))),
    runtimeRoot,
    dataDir,
    dataPath: path.resolve(env("APPHUB_DATA_PATH", path.join(dataDir, "apphub.json"))),
    databaseUrl: env("DATABASE_URL"),
    baseUrl: env("APPHUB_BASE_URL", "https://apphub.sisp.com"),
    appDomain,
    appUrlSuffix: `.${appDomain}`,
    mapDriveUrl: env("APPHUB_MAPDRIVE_URL", "https://mapdrive.sisp.com"),
    trustedAuthHeader: env("APPHUB_TRUSTED_AUTH_HEADER", "x-remote-user").toLowerCase(),
    trustedGroupsHeader: env("APPHUB_TRUSTED_GROUPS_HEADER", "x-remote-groups").toLowerCase(),
    adminUsers: new Set(listEnv("APPHUB_ADMIN_USERS", ["admin"])),
    adminGroups: new Set(listEnv("APPHUB_ADMIN_GROUPS")),
    allowDevLogin: env("APPHUB_DEV_AUTH", nodeEnv === "production" ? "0" : "1") === "1",
    allowMockLaunches: env("APPHUB_ALLOW_MOCK_LAUNCHES", nodeEnv === "production" ? "0" : "1") === "1",
    sessionCookie: env("APPHUB_SESSION_COOKIE", "apphub_dev_user"),
    portRange: parsePortRange(env("APPHUB_PORT_RANGE", "31000-31999")),
    slurmMode,
    clusterNodes: listEnv("APPHUB_CLUSTER_NODES", ["node1", "node2", "node3", "node4"]),
    clusterMaxCpus: intEnv("APPHUB_CLUSTER_MAX_CPUS", 112),
    clusterMaxMemoryMb: intEnv("APPHUB_CLUSTER_MAX_MEMORY_MB", 515072),
    defaultNodes: listEnv("APPHUB_DEFAULT_NODES", ["node2", "node3", "node4"]),
    slurmPartition: env("APPHUB_SLURM_PARTITION"),
    sbatchWrapper: path.resolve(env("APPHUB_SBATCH_WRAPPER", path.join(apphubRoot, "runtime", "wrappers", "apphub-sbatch-as-user.sh"))),
    scancelWrapper: path.resolve(env("APPHUB_SCANCEL_WRAPPER", path.join(apphubRoot, "runtime", "wrappers", "apphub-sbatch-as-user.sh"))),
    runnerPath: path.resolve(env("APPHUB_RUNNER_PATH", path.join(runtimeRoot, "wrappers", "apphub-runner.sh"))),
    templatePath: path.resolve(env("APPHUB_TEMPLATE_PATH", path.join(runtimeRoot, "templates.json"))),
    jobRoot: path.resolve(env("APPHUB_JOB_ROOT", path.join(dataDir, "jobs"))),
    logRoot: path.resolve(env("APPHUB_LOG_ROOT", path.join(dataDir, "logs"))),
    workspaceBase: env("APPHUB_WORKSPACE_BASE", "/mnt/sisplockers/apphub/workspaces"),
    homeBase: env("APPHUB_HOME_BASE", "/home"),
    imageRoot: env("APPHUB_IMAGE_ROOT", "/mnt/sisplockers/apphub/images"),
    nginxRouteMapPath: env("APPHUB_NGINX_ROUTE_MAP"),
    nginxReloadCommand: env("APPHUB_NGINX_RELOAD_CMD"),
    reconcileIntervalMs: intEnv("APPHUB_RECONCILE_INTERVAL_MS", 30000),
    maxBodyBytes: intEnv("APPHUB_MAX_BODY_BYTES", 256 * 1024)
  };
}
