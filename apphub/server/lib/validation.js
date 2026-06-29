const slugPattern = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const usernamePattern = /^[a-z_][a-z0-9_.-]{0,63}$/i;

export function cleanText(value, limit = 200) {
  return String(value ?? "").replace(/\r/g, "").trim().slice(0, limit);
}

export function slugify(value) {
  const slug = cleanText(value, 64)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slugPattern.test(slug) ? slug : "";
}

export function assertUsername(value) {
  const user = cleanText(value, 64);
  if (!usernamePattern.test(user)) throw Object.assign(new Error("Invalid username."), { statusCode: 400 });
  return user;
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function publicApp(app) {
  return {
    id: app.id,
    owner: app.owner,
    name: app.name,
    slug: app.slug,
    templateId: app.templateId,
    templateName: app.templateName,
    status: app.status,
    visibility: app.visibility,
    cpus: app.cpus,
    memoryMb: app.memoryMb,
    timeLimitMinutes: app.timeLimitMinutes,
    workspacePath: app.workspacePath,
    entrypoint: app.entrypoint,
    port: app.port,
    node: app.node,
    targetHost: app.targetHost,
    slurmJobId: app.slurmJobId,
    routeHost: app.routeHost,
    url: app.url,
    approvalStatus: app.approvalStatus,
    persistentRequested: Boolean(app.persistentRequested),
    persistentApproved: Boolean(app.persistentApproved),
    lastError: app.lastError,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    startedAt: app.startedAt,
    stoppedAt: app.stoppedAt
  };
}

export function isActiveStatus(status) {
  return ["queued", "starting", "running", "pending-route"].includes(status);
}
