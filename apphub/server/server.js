import { createServer } from "node:http";
import { access, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { jsonResponse, readJsonBody, serveStatic } from "./lib/http.js";
import { createStore } from "./lib/store.js";
import { SlurmClient } from "./lib/slurm.js";
import { syncNginxRoutes } from "./lib/routes.js";
import { assertUsername, clampInteger, cleanText, isActiveStatus, publicApp, slugify } from "./lib/validation.js";

const __filename = fileURLToPath(import.meta.url);

function nowIso() {
  return new Date().toISOString();
}

function parseCookies(header) {
  const result = new Map();
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return result;
}

function getHeader(req, name) {
  return req.headers[String(name).toLowerCase()];
}

function actorFromRequest(config, req) {
  const headerUser = cleanText(getHeader(req, config.trustedAuthHeader), 64);
  const cookies = parseCookies(req.headers.cookie);
  const cookieUser = config.allowDevLogin ? cleanText(cookies.get(config.sessionCookie), 64) : "";
  const username = headerUser || cookieUser;
  if (!username) return null;
  const groups = cleanText(getHeader(req, config.trustedGroupsHeader), 500)
    .split(/[,\s]+/)
    .map((group) => group.trim())
    .filter(Boolean);
  const isAdmin = config.adminUsers.has(username) || groups.some((group) => config.adminGroups.has(group));
  return { username, groups, isAdmin };
}

function requireActor(config, req) {
  const actor = actorFromRequest(config, req);
  if (!actor) throw Object.assign(new Error("Login required."), { statusCode: 401 });
  assertUsername(actor.username);
  return actor;
}

function requireAdmin(config, req) {
  const actor = requireActor(config, req);
  if (!actor.isAdmin) throw Object.assign(new Error("Admin access required."), { statusCode: 403 });
  return actor;
}

function ensureOwnsApp(actor, app) {
  if (!app) throw Object.assign(new Error("App not found."), { statusCode: 404 });
  if (!actor.isAdmin && app.owner !== actor.username) {
    throw Object.assign(new Error("App not found."), { statusCode: 404 });
  }
}

function normalizeVisibility(value) {
  return ["private", "team", "public"].includes(value) ? value : "private";
}

function normalizeSupportStatus(value, isAdmin) {
  if (value === "solved") return "solved";
  if (value === "admin-needed") return "admin-needed";
  return "open";
}

function appRouteHost(config, slug, owner) {
  return `${slug}-${owner}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50).replace(/-+$/g, "") + config.appUrlSuffix;
}

function buildWorkspacePath(config, owner, requested) {
  const safe = cleanText(requested, 180);
  if (safe.startsWith("/")) return safe;
  const folder = safe || "default";
  return path.posix.join(config.workspaceBase, owner, folder.replace(/[^a-zA-Z0-9_.-]/g, "-"));
}

function buildLogDir(config, appId) {
  return path.join(config.logRoot, appId);
}

function templateLimit(template, key, fallback) {
  return Number(template[key] || fallback);
}

function normalizeTimeLimit(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (parsed === 0) return 0;
  return clampInteger(value, fallback, 15, max);
}

function assertRuntimeLaunchAllowed(config) {
  if (config.slurmMode === "mock" && !config.allowMockLaunches) {
    throw Object.assign(
      new Error("App launches are temporarily disabled while AppHub is in staging mode. Ask an admin to enable Slurm runtime before starting apps."),
      { statusCode: 503 }
    );
  }
}

function runtimeInfo(config) {
  const launchesEnabled = config.slurmMode !== "mock" || config.allowMockLaunches;
  return {
    slurmMode: config.slurmMode,
    launchesEnabled,
    message: launchesEnabled
      ? (config.slurmMode === "slurm" ? "App launches are enabled through Slurm." : "App launches are enabled.")
      : "App launches are temporarily disabled while AppHub is in staging mode. Ask an admin to enable Slurm runtime before starting apps."
  };
}

function resolveTemplateImage(config, template) {
  if (!template.image) return "";
  if (path.isAbsolute(template.image)) return template.image;
  return path.posix.join(config.imageRoot.replace(/\\/g, "/"), template.image);
}

async function assertTemplateImageAvailable(config, template) {
  if (config.slurmMode !== "slurm" || !template.image) return;
  const imagePath = resolveTemplateImage(config, template);
  try {
    await access(imagePath);
  } catch {
    throw Object.assign(new Error(`Template image is not available yet: ${imagePath}`), { statusCode: 503 });
  }
}

function createAppRecord(config, actor, template, body, port) {
  const name = cleanText(body.name, 80);
  const slug = slugify(body.slug || name);
  if (!name || !slug) throw Object.assign(new Error("A valid app name is required."), { statusCode: 400 });

  const cpus = clampInteger(body.cpus, template.defaultCpus || 1, 1, templateLimit(template, "maxCpus", 32));
  const memoryMb = clampInteger(
    body.memoryMb || Number(body.memoryGb || 0) * 1024,
    template.defaultMemoryMb || 4096,
    512,
    templateLimit(template, "maxMemoryMb", 131072)
  );
  const timeLimitMinutes = normalizeTimeLimit(
    body.timeLimitMinutes,
    template.defaultTimeMinutes || 240,
    templateLimit(template, "maxTimeMinutes", 1440)
  );
  const id = randomUUID();
  const owner = actor.username;
  const routeHost = appRouteHost(config, slug, owner);
  const logDir = buildLogDir(config, id);

  return {
    id,
    owner,
    name,
    slug,
    slurmName: `apphub-${slug}`.slice(0, 48),
    templateId: template.id,
    templateName: template.name,
    status: "starting",
    visibility: normalizeVisibility(body.visibility),
    cpus,
    memoryMb,
    timeLimitMinutes,
    workspacePath: buildWorkspacePath(config, owner, body.workspacePath),
    entrypoint: cleanText(body.entrypoint || template.defaultEntrypoint || "", 180),
    port,
    node: "",
    targetHost: "",
    slurmJobId: "",
    routeHost,
    url: `https://${routeHost}`,
    approvalStatus: "not-requested",
    persistentRequested: false,
    persistentApproved: false,
    allowedNodes: Array.isArray(body.allowedNodes) && actor.isAdmin ? body.allowedNodes : config.defaultNodes,
    logDir,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

async function launchApp(config, store, slurm, actor, body) {
  const template = await store.getTemplate(cleanText(body.templateId, 80));
  if (!template || template.enabled === false) {
    throw Object.assign(new Error("Template is not available."), { statusCode: 400 });
  }
  assertRuntimeLaunchAllowed(config);
  await assertTemplateImageAvailable(config, template);
  if (body.visibility === "public") {
    throw Object.assign(new Error("Public apps require admin approval after launch."), { statusCode: 400 });
  }

  const port = await store.allocatePort(config.portRange);
  const app = createAppRecord(config, actor, template, body, port);
  await mkdir(app.logDir, { recursive: true });
  await chmod(app.logDir, 0o2775).catch(() => {});
  await store.createApp(app);
  try {
    const launch = await slurm.launch(app, template);
    const patch = {
      ...launch,
      status: launch.status,
      targetHost: launch.targetHost || app.targetHost,
      node: launch.node || app.node,
      startedAt: launch.startedAt || app.startedAt
    };
    const updated = await store.updateApp(app.id, patch);
    if (updated.targetHost) {
      await store.upsertRoute({
        host: updated.routeHost,
        appId: updated.id,
        owner: updated.owner,
        targetHost: updated.targetHost,
        targetPort: updated.port,
        status: "active",
        url: updated.url
      });
      await syncNginxRoutes(config, store);
    }
    await store.addAudit({
      actor: actor.username,
      action: "app.launch",
      targetType: "app",
      targetId: app.id,
      data: { templateId: app.templateId, port: app.port, slurmJobId: launch.slurmJobId }
    });
    return updated;
  } catch (error) {
    await store.removeRoute(app.routeHost).catch(() => {});
    await syncNginxRoutes(config, store).catch(() => {});
    const failed = await store.updateApp(app.id, { status: "failed", lastError: error.message });
    await store.addAudit({
      actor: actor.username,
      action: "app.launch.failed",
      targetType: "app",
      targetId: app.id,
      data: { error: error.message }
    });
    return failed;
  }
}

async function restartExistingApp(config, store, slurm, actor, app) {
  const template = await store.getTemplate(app.templateId);
  if (!template || template.enabled === false) {
    throw Object.assign(new Error("Template is not available."), { statusCode: 400 });
  }
  assertRuntimeLaunchAllowed(config);
  await assertTemplateImageAvailable(config, template);
  await slurm.cancel(app);
  await store.removeRoute(app.routeHost);
  const port = app.port || await store.allocatePort(config.portRange);
  const reset = await store.updateApp(app.id, {
    status: "starting",
    port,
    targetHost: "",
    node: "",
    slurmJobId: "",
    lastError: "",
    stoppedAt: "",
    startedAt: "",
    updatedAt: nowIso()
  });
  try {
    const launch = await slurm.launch(reset, template);
    const updated = await store.updateApp(app.id, {
      ...launch,
      status: launch.status,
      targetHost: launch.targetHost || "",
      node: launch.node || "",
      startedAt: launch.startedAt || nowIso()
    });
    if (updated.targetHost) {
      await store.upsertRoute({
        host: updated.routeHost,
        appId: updated.id,
        owner: updated.owner,
        targetHost: updated.targetHost,
        targetPort: updated.port,
        status: "active",
        url: updated.url
      });
      await syncNginxRoutes(config, store);
    }
    await store.addAudit({ actor: actor.username, action: "app.restart", targetType: "app", targetId: app.id });
    return updated;
  } catch (error) {
    await store.removeRoute(app.routeHost).catch(() => {});
    await syncNginxRoutes(config, store).catch(() => {});
    const failed = await store.updateApp(app.id, { status: "failed", lastError: error.message });
    await store.addAudit({
      actor: actor.username,
      action: "app.restart.failed",
      targetType: "app",
      targetId: app.id,
      data: { error: error.message }
    });
    return failed;
  }
}

async function reconcileApps(config, store, slurm) {
  const apps = await store.listApps({ includeAll: true });
  const active = apps.filter((app) => ["queued", "starting", "pending-route", "running"].includes(app.status));
  const changes = [];
  const promoteAfterRouteSync = [];
  for (const app of active) {
    const status = await slurm.readJobStatus(app);
    if (!status) continue;
    const patch = {};
    const discoveredTarget = Boolean(status.host && !app.targetHost);
    if (status.host && !app.targetHost) {
      patch.targetHost = status.host;
      patch.node = status.host.split(".")[0];
    }
    if (status.state === "RUNNING" || status.state === "starting" || status.state === "STARTING") {
      patch.status = status.host || app.targetHost ? (discoveredTarget ? "pending-route" : "running") : app.status;
    } else if (["COMPLETED", "CANCELLED", "FAILED", "TIMEOUT", "OUT_OF_MEMORY"].includes(status.state)) {
      patch.status = status.state === "COMPLETED" ? "stopped" : "failed";
      patch.stoppedAt = nowIso();
      if (status.state !== "COMPLETED") patch.lastError = status.error || `Slurm state: ${status.state}`;
    }
    if (Object.keys(patch).length) {
      const updated = await store.updateApp(app.id, patch);
      changes.push(updated);
      if (updated.targetHost && ["pending-route", "running"].includes(updated.status)) {
        await store.upsertRoute({
          host: updated.routeHost,
          appId: updated.id,
          owner: updated.owner,
          targetHost: updated.targetHost,
          targetPort: updated.port,
          status: "active",
          url: updated.url
        });
        if (updated.status === "pending-route") promoteAfterRouteSync.push(updated.id);
      }
      if (["stopped", "failed"].includes(updated.status)) {
        await store.removeRoute(updated.routeHost);
      }
    }
  }
  if (changes.length) await syncNginxRoutes(config, store);
  for (const appId of promoteAfterRouteSync) {
    changes.push(await store.updateApp(appId, { status: "running" }));
  }
  return changes;
}

async function readAppLogs(app) {
  const files = ["stdout.log", "stderr.log"];
  const result = {};
  for (const file of files) {
    try {
      result[file] = (await readFile(path.join(app.logDir, file), "utf8")).slice(-20000);
    } catch {
      result[file] = "";
    }
  }
  return result;
}

function supportThreadPublic(thread) {
  return {
    id: thread.id,
    title: thread.title,
    author: thread.author,
    body: thread.body,
    status: thread.status,
    context: thread.context || {},
    reactions: thread.reactions || {},
    replies: thread.replies || [],
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt
  };
}

async function handleApi(req, res, url, services) {
  const { config, store, slurm } = services;

  if (req.method === "GET" && url.pathname === "/api/health") {
    return jsonResponse(res, 200, {
      ok: true,
      service: "sisp-apphub",
      slurmMode: config.slurmMode,
      runtime: runtimeInfo(config),
      store: config.databaseUrl ? "postgres" : "file"
    });
  }

  if (req.method === "GET" && url.pathname === "/api/session") {
    const actor = actorFromRequest(config, req);
    return jsonResponse(res, 200, {
      authenticated: Boolean(actor),
      user: actor || null,
      devLogin: config.allowDevLogin,
      runtime: runtimeInfo(config)
    });
  }

  if (req.method === "POST" && url.pathname === "/api/session/dev-login") {
    if (!config.allowDevLogin) throw Object.assign(new Error("Development login is disabled."), { statusCode: 404 });
    const body = await readJsonBody(req, config.maxBodyBytes);
    const username = assertUsername(body.username || "demo");
    const headers = {
      "Set-Cookie": `${config.sessionCookie}=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Lax`
    };
    return jsonResponse(res, 200, { authenticated: true, user: { username, isAdmin: config.adminUsers.has(username), groups: [] } }, headers);
  }

  if (req.method === "POST" && url.pathname === "/api/session/logout") {
    return jsonResponse(res, 200, { ok: true }, { "Set-Cookie": `${config.sessionCookie}=; Path=/; Max-Age=0; SameSite=Lax` });
  }

  if (req.method === "GET" && url.pathname === "/api/templates") {
    requireActor(config, req);
    return jsonResponse(res, 200, { templates: await store.listTemplates() });
  }

  if (req.method === "GET" && url.pathname === "/api/apps") {
    const actor = requireActor(config, req);
    await reconcileApps(config, store, slurm);
    const apps = await store.listApps({ user: actor.username, includeAll: actor.isAdmin && url.searchParams.get("all") === "1" });
    return jsonResponse(res, 200, { apps: apps.map(publicApp) });
  }

  if (req.method === "POST" && url.pathname === "/api/apps/clear") {
    const actor = requireActor(config, req);
    await reconcileApps(config, store, slurm);
    const removed = await store.clearApps({ user: actor.username, statuses: ["stopped", "failed"] });
    await syncNginxRoutes(config, store);
    await store.addAudit({
      actor: actor.username,
      action: "app.clear.inactive",
      targetType: "app",
      data: { count: removed.length, appIds: removed.map((app) => app.id) }
    });
    return jsonResponse(res, 200, { cleared: removed.length });
  }

  if (req.method === "POST" && url.pathname === "/api/apps") {
    const actor = requireActor(config, req);
    const body = await readJsonBody(req, config.maxBodyBytes);
    const app = await launchApp(config, store, slurm, actor, body);
    return jsonResponse(res, app.status === "failed" ? 500 : 201, { app: publicApp(app) });
  }

  const appClearMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/clear$/);
  if (req.method === "POST" && appClearMatch) {
    const actor = requireActor(config, req);
    await reconcileApps(config, store, slurm);
    const app = await store.getApp(appClearMatch[1]);
    ensureOwnsApp(actor, app);
    if (isActiveStatus(app.status)) {
      throw Object.assign(new Error("Stop the app before clearing it from the list."), { statusCode: 409 });
    }
    await store.deleteApp(app.id);
    await store.removeRoute(app.routeHost);
    await syncNginxRoutes(config, store);
    await store.addAudit({ actor: actor.username, action: "app.clear", targetType: "app", targetId: app.id });
    return jsonResponse(res, 200, { cleared: 1 });
  }

  const appStopMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/stop$/);
  if (req.method === "POST" && appStopMatch) {
    const actor = requireActor(config, req);
    const app = await store.getApp(appStopMatch[1]);
    ensureOwnsApp(actor, app);
    await slurm.cancel(app);
    const updated = await store.updateApp(app.id, { status: "stopped", stoppedAt: nowIso() });
    await store.removeRoute(app.routeHost);
    await syncNginxRoutes(config, store);
    await store.addAudit({ actor: actor.username, action: "app.stop", targetType: "app", targetId: app.id });
    return jsonResponse(res, 200, { app: publicApp(updated) });
  }

  const appRestartMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/restart$/);
  if (req.method === "POST" && appRestartMatch) {
    const actor = requireActor(config, req);
    const app = await store.getApp(appRestartMatch[1]);
    ensureOwnsApp(actor, app);
    const restarted = await restartExistingApp(config, store, slurm, actor, app);
    return jsonResponse(res, restarted.status === "failed" ? 500 : 200, { app: publicApp(restarted) });
  }

  const appDuplicateMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/duplicate$/);
  if (req.method === "POST" && appDuplicateMatch) {
    const actor = requireActor(config, req);
    const app = await store.getApp(appDuplicateMatch[1]);
    ensureOwnsApp(actor, app);
    const body = {
      name: `${app.name} copy`,
      slug: `${app.slug}-${Date.now().toString(36)}`.slice(0, 40),
      templateId: app.templateId,
      cpus: app.cpus,
      memoryMb: app.memoryMb,
      timeLimitMinutes: app.timeLimitMinutes,
      workspacePath: app.workspacePath,
      entrypoint: app.entrypoint,
      visibility: app.visibility
    };
    const duplicated = await launchApp(config, store, slurm, actor, body);
    await store.addAudit({ actor: actor.username, action: "app.duplicate", targetType: "app", targetId: app.id, data: { newAppId: duplicated.id } });
    return jsonResponse(res, 201, { app: publicApp(duplicated) });
  }

  const appLogsMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/logs$/);
  if (req.method === "GET" && appLogsMatch) {
    const actor = requireActor(config, req);
    const app = await store.getApp(appLogsMatch[1]);
    ensureOwnsApp(actor, app);
    return jsonResponse(res, 200, { logs: await readAppLogs(app) });
  }

  const appPersistenceMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/persistence$/);
  if (req.method === "POST" && appPersistenceMatch) {
    const actor = requireActor(config, req);
    const app = await store.getApp(appPersistenceMatch[1]);
    ensureOwnsApp(actor, app);
    const updated = await store.updateApp(app.id, {
      persistentRequested: true,
      approvalStatus: "pending",
      requestedAt: nowIso()
    });
    await store.addAudit({ actor: actor.username, action: "app.persistence.request", targetType: "app", targetId: app.id });
    return jsonResponse(res, 200, { app: publicApp(updated) });
  }

  if (req.method === "GET" && url.pathname === "/api/drives") {
    const actor = requireActor(config, req);
    const workspacePath = path.posix.join(config.workspaceBase, actor.username);
    return jsonResponse(res, 200, {
      username: actor.username,
      mapDriveUrl: config.mapDriveUrl,
      connectionStatus: "Use MapDrive for desktop setup. AppHub jobs use the Linux paths directly.",
      shares: [
        {
          name: "sisplockers",
          description: "Main shared project storage.",
          windowsPath: "\\\\192.168.0.103\\sisplockers",
          macPath: "smb://192.168.0.103/sisplockers",
          linuxPath: "/mnt/sisplockers",
          recommended: true
        },
        {
          name: "AppHub workspace",
          description: "Default folder used by apps launched from AppHub.",
          windowsPath: `\\\\192.168.0.103\\sisplockers\\apphub\\workspaces\\${actor.username}`,
          macPath: `smb://192.168.0.103/sisplockers/apphub/workspaces/${actor.username}`,
          linuxPath: workspacePath,
          recommended: true
        }
      ],
      uidNotice: "Direct NAS SMB may show incorrect Linux UID/GID until the LDAP-backed Samba gateway is deployed.",
      sambaGateway: {
        status: "planned",
        linuxMount: "/mnt/sisplockers",
        goal: "Expose the same storage through a Linux Samba gateway joined to LDAP/NSS so Windows and macOS writes keep the expected Linux UID/GID."
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/support") {
    requireActor(config, req);
    const threads = await store.listSupport();
    return jsonResponse(res, 200, { threads: threads.map(supportThreadPublic) });
  }

  if (req.method === "POST" && url.pathname === "/api/support") {
    const actor = requireActor(config, req);
    const body = await readJsonBody(req, config.maxBodyBytes);
    const title = cleanText(body.title, 140);
    const message = cleanText(body.body, 4000);
    if (!title || !message) throw Object.assign(new Error("Title and details are required."), { statusCode: 400 });
    const thread = {
      id: randomUUID(),
      title,
      author: actor.username,
      body: message,
      status: normalizeSupportStatus(body.status, actor.isAdmin),
      context: {
        appId: cleanText(body.appId, 80),
        jobId: cleanText(body.jobId, 80),
        drive: cleanText(body.drive, 120)
      },
      reactions: { same: 0, helpful: 0, thanks: 0 },
      replies: [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await store.createSupportThread(thread);
    await store.addAudit({ actor: actor.username, action: "support.create", targetType: "support", targetId: thread.id });
    return jsonResponse(res, 201, { thread: supportThreadPublic(thread) });
  }

  const supportRepliesMatch = url.pathname.match(/^\/api\/support\/([^/]+)\/replies$/);
  if (req.method === "POST" && supportRepliesMatch) {
    const actor = requireActor(config, req);
    const body = await readJsonBody(req, config.maxBodyBytes);
    const message = cleanText(body.body, 2000);
    if (!message) throw Object.assign(new Error("Reply body is required."), { statusCode: 400 });
    const thread = await store.updateSupportThread(supportRepliesMatch[1], (item) => {
      item.replies ||= [];
      item.replies.push({ id: randomUUID(), author: actor.username, body: message, createdAt: nowIso() });
    });
    if (!thread) throw Object.assign(new Error("Thread not found."), { statusCode: 404 });
    return jsonResponse(res, 201, { thread: supportThreadPublic(thread) });
  }

  const supportReactionsMatch = url.pathname.match(/^\/api\/support\/([^/]+)\/reactions$/);
  if (req.method === "POST" && supportReactionsMatch) {
    requireActor(config, req);
    const body = await readJsonBody(req, config.maxBodyBytes);
    const reaction = cleanText(body.reaction, 24);
    if (!["same", "helpful", "thanks"].includes(reaction)) throw Object.assign(new Error("Invalid reaction."), { statusCode: 400 });
    const thread = await store.updateSupportThread(supportReactionsMatch[1], (item) => {
      item.reactions ||= { same: 0, helpful: 0, thanks: 0 };
      item.reactions[reaction] = Number(item.reactions[reaction] || 0) + 1;
    });
    if (!thread) throw Object.assign(new Error("Thread not found."), { statusCode: 404 });
    return jsonResponse(res, 200, { thread: supportThreadPublic(thread) });
  }

  const supportStatusMatch = url.pathname.match(/^\/api\/support\/([^/]+)\/status$/);
  if (req.method === "PATCH" && supportStatusMatch) {
    const actor = requireActor(config, req);
    const body = await readJsonBody(req, config.maxBodyBytes);
    const thread = await store.updateSupportThread(supportStatusMatch[1], (item) => {
      item.status = normalizeSupportStatus(body.status, actor.isAdmin);
    });
    if (!thread) throw Object.assign(new Error("Thread not found."), { statusCode: 404 });
    return jsonResponse(res, 200, { thread: supportThreadPublic(thread) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/overview") {
    requireAdmin(config, req);
    await reconcileApps(config, store, slurm);
    const apps = await store.listApps({ includeAll: true });
    const routes = await store.listRoutes();
    const support = await store.listSupport();
    return jsonResponse(res, 200, {
      apps: apps.map(publicApp),
      routes,
      supportOpen: support.filter((thread) => thread.status !== "solved").length,
      counts: {
        running: apps.filter((app) => app.status === "running").length,
        queued: apps.filter((app) => ["queued", "starting", "pending-route"].includes(app.status)).length,
        failed: apps.filter((app) => app.status === "failed").length,
        approvals: apps.filter((app) => app.approvalStatus === "pending").length
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/routes") {
    requireAdmin(config, req);
    return jsonResponse(res, 200, { routes: await store.listRoutes() });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/reconcile") {
    requireAdmin(config, req);
    const changes = await reconcileApps(config, store, slurm);
    return jsonResponse(res, 200, { changed: changes.map(publicApp) });
  }

  const approvalMatch = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)\/approval$/);
  if (req.method === "PATCH" && approvalMatch) {
    const actor = requireAdmin(config, req);
    const app = await store.getApp(approvalMatch[1]);
    if (!app) throw Object.assign(new Error("App not found."), { statusCode: 404 });
    const body = await readJsonBody(req, config.maxBodyBytes);
    const approved = body.status === "approved";
    const patch = {
      approvalStatus: approved ? "approved" : "rejected",
      persistentApproved: approved,
      approvedBy: actor.username,
      approvedAt: nowIso()
    };
    if (approved) {
      patch.visibility = body.visibility === "public" ? "public" : app.visibility;
      patch.timeLimitMinutes = normalizeTimeLimit(body.timeLimitMinutes, app.timeLimitMinutes, 10080);
      patch.cpus = clampInteger(body.cpus, app.cpus, 1, config.clusterMaxCpus);
      patch.memoryMb = clampInteger(body.memoryMb, app.memoryMb, 512, config.clusterMaxMemoryMb);
      if (body.routeHost) patch.routeHost = cleanText(body.routeHost, 120).toLowerCase();
      patch.url = `https://${patch.routeHost || app.routeHost}`;
    }
    const updated = await store.updateApp(app.id, patch);
    if (approved && updated.targetHost && updated.status === "running") {
      if (updated.routeHost !== app.routeHost) await store.removeRoute(app.routeHost);
      await store.upsertRoute({
        host: updated.routeHost,
        appId: updated.id,
        owner: updated.owner,
        targetHost: updated.targetHost,
        targetPort: updated.port,
        status: "active",
        url: updated.url
      });
      await syncNginxRoutes(config, store);
    }
    await store.addAudit({
      actor: actor.username,
      action: approved ? "app.approve" : "app.reject",
      targetType: "app",
      targetId: app.id,
      data: patch
    });
    return jsonResponse(res, 200, { app: publicApp(updated) });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/templates") {
    requireAdmin(config, req);
    return jsonResponse(res, 200, { templates: await store.listTemplates({ includeDisabled: true }) });
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/admin/templates/")) {
    const actor = requireAdmin(config, req);
    const id = cleanText(url.pathname.split("/").pop(), 80);
    const body = await readJsonBody(req, config.maxBodyBytes);
    if (!id || !Array.isArray(body.command)) throw Object.assign(new Error("Template id and command are required."), { statusCode: 400 });
    const template = await store.upsertTemplate({ ...body, id }, actor.username);
    return jsonResponse(res, 200, { template });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/audit") {
    requireAdmin(config, req);
    return jsonResponse(res, 200, { events: await store.listAudit(200) });
  }

  throw Object.assign(new Error("Not found."), { statusCode: 404 });
}

export async function createAppServer(overrides = {}) {
  const config = { ...loadConfig(), ...overrides };
  const store = overrides.store || await createStore(config);
  const slurm = overrides.slurm || new SlurmClient(config);
  let reconcileTimer = null;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, res, url, { config, store, slurm });
      }
      return await serveStatic(req, res, url, config.webRoot);
    } catch (error) {
      return jsonResponse(res, error.statusCode || 500, { error: error.message || "Server error." });
    }
  });

  server.startReconcile = () => {
    if (reconcileTimer || config.reconcileIntervalMs <= 0) return;
    reconcileTimer = setInterval(() => {
      reconcileApps(config, store, slurm).catch((error) => {
        console.error(`reconcile failed: ${error.message}`);
      });
    }, config.reconcileIntervalMs);
    reconcileTimer.unref?.();
  };
  server.stopReconcile = () => {
    if (reconcileTimer) clearInterval(reconcileTimer);
    reconcileTimer = null;
  };
  server.apphub = { config, store, slurm, reconcile: () => reconcileApps(config, store, slurm) };
  return server;
}

export async function start() {
  const server = await createAppServer();
  server.listen(server.apphub.config.port, server.apphub.config.host, () => {
    console.log(`sisp-apphub listening on ${server.apphub.config.host}:${server.apphub.config.port}`);
  });
  server.startReconcile();
  return server;
}

if (process.argv[1] === __filename) {
  start().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
