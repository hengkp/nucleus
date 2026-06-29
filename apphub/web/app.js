const state = {
  session: null,
  templates: [],
  apps: [],
  support: [],
  drives: null,
  admin: null,
  view: "home",
  messageTimer: null
};

const views = {
  home: ["Home", "Launch and manage Slurm-backed apps."],
  apps: ["My apps", "Start, stop, inspect logs, and request persistent hosting."],
  drives: ["My drives", "Open MapDrive and review recommended storage paths."],
  support: ["Support", "Post issues with app, job, or drive context attached."],
  admin: ["Admin", "Review jobs, approvals, routes, and audit events."]
};

function qs(selector, root = document) {
  return root.querySelector(selector);
}

function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.app?.lastError || `Request failed: ${response.status}`);
  return data;
}

function showMessage(text, tone = "info") {
  const box = qs("#message");
  if (state.messageTimer) window.clearTimeout(state.messageTimer);
  box.textContent = text;
  box.classList.toggle("error", tone === "error");
  box.classList.remove("hidden");
  state.messageTimer = window.setTimeout(() => box.classList.add("hidden"), tone === "error" ? 10000 : 5000);
}

async function withSubmitState(form, pendingText, fn) {
  const button = form.querySelector('button[type="submit"]');
  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = pendingText;
  }
  try {
    return await fn();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function statusBadge(status) {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function isActiveApp(app) {
  return ["queued", "starting", "running", "pending-route"].includes(app.status);
}

function joinMeta(parts) {
  return parts.filter(Boolean).map((item) => escapeHtml(item)).join(" &middot; ");
}

function formatMemory(mb) {
  const value = Number(mb) || 0;
  return value >= 1024 ? `${Math.round(value / 1024)} GB` : `${value} MB`;
}

function formatTimeLimit(minutes) {
  const value = Number(minutes) || 0;
  if (value === 0) return "No limit";
  if (value % 1440 === 0) return `${value / 1440} day${value === 1440 ? "" : "s"}`;
  if (value % 60 === 0) return `${value / 60} hour${value === 60 ? "" : "s"}`;
  return `${value} min`;
}

function memoryGbFromMb(mb) {
  return Math.max(1, Math.floor((Number(mb) || 1024) / 1024));
}

function setView(view) {
  state.view = view;
  qsa(".nav button").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  qsa(".view").forEach((panel) => panel.classList.add("hidden"));
  qs(`#${view}View`)?.classList.remove("hidden");
  qs("#viewTitle").textContent = views[view][0];
  qs("#viewSubtitle").textContent = views[view][1];
}

function updateChrome() {
  const actor = state.session?.user;
  const signedIn = Boolean(state.session?.authenticated);
  qs("#loginPanel").classList.toggle("hidden", signedIn);
  qs(".topbar").classList.toggle("hidden", !signedIn);
  qs("#userName").textContent = signedIn ? actor.username : "Signed out";
  qsa(".admin-only").forEach((item) => item.classList.toggle("hidden", !actor?.isAdmin));
  if (!signedIn) {
    qsa(".view").forEach((item) => item.classList.add("hidden"));
    return;
  }
  if (state.view === "admin" && !actor?.isAdmin) {
    setView("home");
    return;
  }
  setView(state.view);
}

function renderLaunchNotice() {
  const notice = qs("#launchNotice");
  const runtime = state.session?.runtime;
  if (!notice || !runtime) return;
  if (runtime.launchesEnabled) {
    notice.classList.add("hidden");
    notice.textContent = "";
    return;
  }
  notice.textContent = runtime.message;
  notice.classList.remove("hidden");
}

function fillTemplates() {
  const select = qs('#launchForm select[name="templateId"]');
  select.innerHTML = state.templates
    .map((template) => `<option value="${escapeHtml(template.id)}">${escapeHtml(template.name)}</option>`)
    .join("");
  const contextSelect = qs('#supportForm select[name="appId"]');
  contextSelect.innerHTML = `<option value="">No app context</option>${state.apps
    .map((app) => `<option value="${escapeHtml(app.id)}">${escapeHtml(app.name)}</option>`)
    .join("")}`;
  applyTemplateDefaults();
}

function selectedTemplate() {
  const id = qs('#launchForm select[name="templateId"]').value;
  return state.templates.find((template) => template.id === id);
}

function applyTemplateDefaults() {
  const template = selectedTemplate();
  if (!template) return;
  const maxCpus = template.maxCpus || 64;
  const maxMemoryGb = memoryGbFromMb(template.maxMemoryMb || 131072);
  const defaultCpus = Math.min(template.defaultCpus || 1, maxCpus);
  const defaultMemoryGb = Math.min(memoryGbFromMb(template.defaultMemoryMb || 4096), maxMemoryGb);
  qs("#cpuFieldLabel").textContent = `CPU (max ${maxCpus})`;
  qs("#ramFieldLabel").textContent = `RAM, GB (max ${maxMemoryGb})`;
  qs('#launchForm input[name="cpus"]').max = maxCpus;
  qs('#launchForm input[name="cpus"]').value = defaultCpus;
  qs('#launchForm input[name="memoryGb"]').max = maxMemoryGb;
  qs('#launchForm input[name="memoryGb"]').value = defaultMemoryGb;
  qs('#launchForm input[name="entrypoint"]').value = template.defaultEntrypoint || "";
  qs("#templateSummary").innerHTML = `<strong>${escapeHtml(template.category || "Template")}</strong> ${joinMeta([
    `${defaultCpus} CPU default`,
    `${defaultMemoryGb} GB RAM default`,
    `max ${maxCpus} CPU`,
    `max ${maxMemoryGb} GB RAM`,
    template.defaultEntrypoint ? `entrypoint ${template.defaultEntrypoint}` : ""
  ])}`;
}

function appItem(app) {
  const url = app.url ? `<a class="button-link" href="${escapeHtml(app.url)}" target="_blank" rel="noreferrer">Open</a>` : "";
  return `<article class="item">
    <div class="item-head">
      <div>
        <h3>${escapeHtml(app.name)}</h3>
        <div class="meta">${joinMeta([app.templateName, app.owner, app.routeHost || "route pending"])}</div>
      </div>
      ${statusBadge(app.status)}
    </div>
    <div class="meta">${joinMeta([`${app.cpus} CPU`, formatMemory(app.memoryMb), formatTimeLimit(app.timeLimitMinutes), app.workspacePath])}</div>
    <div class="row-actions">
      ${url}
      <button type="button" data-action="logs" data-id="${escapeHtml(app.id)}">Logs</button>
      <button type="button" data-action="restart" data-id="${escapeHtml(app.id)}">Restart</button>
      <button type="button" data-action="duplicate" data-id="${escapeHtml(app.id)}">Duplicate</button>
      <button type="button" data-action="persistent" data-id="${escapeHtml(app.id)}">Request persistent</button>
      <button class="danger" type="button" data-action="stop" data-id="${escapeHtml(app.id)}">Stop</button>
    </div>
  </article>`;
}

function renderApps() {
  const running = state.apps.filter((app) => app.status === "running").length;
  const queued = state.apps.filter((app) => ["queued", "starting", "pending-route"].includes(app.status)).length;
  const failed = state.apps.filter((app) => app.status === "failed").length;
  const approvals = state.apps.filter((app) => app.approvalStatus === "pending").length;
  qs("#runningCount").textContent = running;
  qs("#queuedCount").textContent = queued;
  qs("#failedCount").textContent = failed;
  qs("#approvalCount").textContent = approvals;
  const clearable = state.apps.filter((app) => !isActiveApp(app)).length;
  qs("#clearAppsBtn").disabled = clearable === 0;

  qs("#appsTable").innerHTML = `<table>
    <thead><tr><th>Name</th><th>Status</th><th>Template</th><th>Resources</th><th>Route</th><th>Approval</th><th>Actions</th></tr></thead>
    <tbody>${state.apps
      .map((app) => `<tr>
        <td>${escapeHtml(app.name)}<br><span class="meta">${escapeHtml(app.workspacePath)}</span></td>
        <td>${statusBadge(app.status)}</td>
        <td>${escapeHtml(app.templateName)}</td>
        <td>${app.cpus} CPU<br>${formatMemory(app.memoryMb)} RAM<br>${formatTimeLimit(app.timeLimitMinutes)}</td>
        <td>${app.url ? `<a href="${escapeHtml(app.url)}" target="_blank" rel="noreferrer">${escapeHtml(app.routeHost)}</a>` : escapeHtml(app.routeHost || "")}</td>
        <td>${escapeHtml(app.approvalStatus)}</td>
        <td><div class="row-actions">
          <button type="button" data-action="logs" data-id="${escapeHtml(app.id)}">Logs</button>
          <button type="button" data-action="restart" data-id="${escapeHtml(app.id)}">Restart</button>
          <button type="button" data-action="duplicate" data-id="${escapeHtml(app.id)}">Duplicate</button>
          <button type="button" data-action="persistent" data-id="${escapeHtml(app.id)}">Persistent</button>
          ${!isActiveApp(app) ? `<button type="button" data-action="clear" data-id="${escapeHtml(app.id)}">Clear</button>` : ""}
          ${isActiveApp(app) ? `<button class="danger" type="button" data-action="stop" data-id="${escapeHtml(app.id)}">Stop</button>` : ""}
        </div></td>
      </tr>`)
      .join("")}</tbody>
  </table>`;
}

function renderDrives() {
  if (!state.drives) return;
  qs("#mapDriveLink").href = state.drives.mapDriveUrl;
  qs("#driveInfo").innerHTML = `
    <div class="drive-row"><strong>Username</strong><span>${escapeHtml(state.drives.username)}</span></div>
    <div class="drive-row"><strong>Connection</strong><span>${escapeHtml(state.drives.connectionStatus)}</span></div>
    ${state.drives.shares
      .map((share) => `<article class="drive-card">
        <div>
          <strong>${escapeHtml(share.name)}</strong>
          <div class="meta">${escapeHtml(share.description || "")}</div>
        </div>
        <div class="path-grid">
          <div class="path-row"><span>Windows</span><code>${escapeHtml(share.windowsPath || "")}</code><button type="button" data-copy="${escapeHtml(share.windowsPath || "")}">Copy</button></div>
          <div class="path-row"><span>macOS</span><code>${escapeHtml(share.macPath || "")}</code><button type="button" data-copy="${escapeHtml(share.macPath || "")}">Copy</button></div>
          <div class="path-row"><span>Linux</span><code>${escapeHtml(share.linuxPath || "")}</code><button type="button" data-copy="${escapeHtml(share.linuxPath || "")}">Copy</button></div>
        </div>
      </article>`)
      .join("")}
    <div class="drive-row"><strong>UID/GID note</strong><span>${escapeHtml(state.drives.uidNotice)}</span></div>
    <div class="drive-row"><strong>Samba gateway</strong><span>${escapeHtml(state.drives.sambaGateway?.status || "planned")} - ${escapeHtml(state.drives.sambaGateway?.goal || "")}</span></div>`;
}

function renderSupport() {
  qs("#supportThreads").innerHTML = state.support
    .map((thread) => `<article class="item">
      <div class="item-head">
        <div>
          <h3>${escapeHtml(thread.title)}</h3>
          <div class="meta">${joinMeta([thread.author, new Date(thread.updatedAt).toLocaleString()])}</div>
        </div>
        ${statusBadge(thread.status)}
      </div>
      <p>${escapeHtml(thread.body)}</p>
      <div class="row-actions">
        <button type="button" data-support-reaction="same" data-id="${escapeHtml(thread.id)}">Same ${thread.reactions?.same || 0}</button>
        <button type="button" data-support-reaction="helpful" data-id="${escapeHtml(thread.id)}">Helpful ${thread.reactions?.helpful || 0}</button>
        <button type="button" data-support-status="solved" data-id="${escapeHtml(thread.id)}">Solved</button>
      </div>
    </article>`)
    .join("") || `<p class="meta">No support posts yet.</p>`;
}

function renderAdmin() {
  const admin = state.admin;
  if (!admin) return;
  qs("#adminApps").innerHTML = `<table>
    <thead><tr><th>App</th><th>User</th><th>Status</th><th>Node</th><th>Job</th><th>Approval</th></tr></thead>
    <tbody>${admin.apps.map((app) => `<tr>
      <td>${escapeHtml(app.name)}<br><span class="meta">${escapeHtml(app.routeHost)}</span></td>
      <td>${escapeHtml(app.owner)}</td>
      <td>${statusBadge(app.status)}</td>
      <td>${escapeHtml(app.node || app.targetHost || "")}</td>
      <td>${escapeHtml(app.slurmJobId || "")}</td>
      <td>${escapeHtml(app.approvalStatus)}<br>
        ${app.approvalStatus === "pending" ? `<div class="row-actions">
          <button type="button" data-admin-approval="approved" data-id="${escapeHtml(app.id)}">Approve</button>
          <button type="button" data-admin-approval="rejected" data-id="${escapeHtml(app.id)}">Reject</button>
        </div>` : ""}
      </td>
    </tr>`).join("")}</tbody>
  </table>`;
  qs("#adminRoutes").innerHTML = `<table>
    <thead><tr><th>Host</th><th>Target</th><th>Status</th></tr></thead>
    <tbody>${admin.routes.map((route) => `<tr>
      <td>${escapeHtml(route.host)}</td>
      <td>${escapeHtml(route.targetHost)}:${escapeHtml(route.targetPort)}</td>
      <td>${statusBadge(route.status)}</td>
    </tr>`).join("")}</tbody>
  </table>`;
}

async function loadAll() {
  state.session = await api("/api/session");
  updateChrome();
  if (!state.session.authenticated) return;
  const [templates, apps, support, drives] = await Promise.all([
    api("/api/templates"),
    api("/api/apps"),
    api("/api/support"),
    api("/api/drives")
  ]);
  state.templates = templates.templates;
  state.apps = apps.apps;
  state.support = support.threads;
  state.drives = drives;
  renderLaunchNotice();
  fillTemplates();
  renderApps();
  renderDrives();
  renderSupport();
  if (state.session.user?.isAdmin) await loadAdmin();
}

async function loadAdmin() {
  try {
    const [overview, audit] = await Promise.all([api("/api/admin/overview"), api("/api/admin/audit")]);
    state.admin = overview;
    renderAdmin();
    qs("#auditLog").innerHTML = `<table>
      <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
      <tbody>${audit.events.map((event) => `<tr>
        <td>${new Date(event.createdAt).toLocaleString()}</td>
        <td>${escapeHtml(event.actor)}</td>
        <td>${escapeHtml(event.action)}</td>
        <td>${escapeHtml(event.targetType || "")}:${escapeHtml(event.targetId || "")}</td>
      </tr>`).join("")}</tbody>
    </table>`;
  } catch (error) {
    showMessage(error.message, "error");
  }
}

async function handleAppAction(action, id) {
  if (action === "logs") {
    const data = await api(`/api/apps/${id}/logs`);
    const box = qs("#logsBox");
    box.textContent = `stdout.log\n${data.logs["stdout.log"] || ""}\n\nstderr.log\n${data.logs["stderr.log"] || ""}`;
    box.classList.remove("hidden");
    setView("apps");
    return;
  }
  if (action === "stop") await api(`/api/apps/${id}/stop`, { method: "POST" });
  if (action === "restart") await api(`/api/apps/${id}/restart`, { method: "POST" });
  if (action === "duplicate") await api(`/api/apps/${id}/duplicate`, { method: "POST" });
  if (action === "persistent") await api(`/api/apps/${id}/persistence`, { method: "POST" });
  if (action === "clear") await api(`/api/apps/${id}/clear`, { method: "POST" });
  await loadAll();
  showMessage("App updated.");
}

function bindEvents() {
  qsa(".nav button").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.view));
  });
  qs("#refreshBtn").addEventListener("click", () => loadAll().catch((error) => showMessage(error.message, "error")));
  qs("#logoutBtn").addEventListener("click", async () => {
    if (state.session?.devLogin) {
      await api("/api/session/logout", { method: "POST" });
      state.session = null;
      await loadAll();
      return;
    }
    window.location.assign("/auth/logout");
  });
  qs("#devLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      await withSubmitState(event.currentTarget, "Signing in...", async () => {
        await api("/api/session/dev-login", { method: "POST", body: { username: form.get("username") } });
        await loadAll();
      });
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  qs('#launchForm select[name="templateId"]').addEventListener("change", applyTemplateDefaults);
  qs("#launchForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      await withSubmitState(event.currentTarget, "Submitting...", async () => {
        await api("/api/apps", {
          method: "POST",
          body: Object.fromEntries(form.entries())
        });
        event.currentTarget.reset();
        await loadAll();
        showMessage("App launch submitted.");
      });
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  qs("#supportForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const form = new FormData(event.currentTarget);
      await withSubmitState(event.currentTarget, "Posting...", async () => {
        await api("/api/support", { method: "POST", body: Object.fromEntries(form.entries()) });
        event.currentTarget.reset();
        await loadAll();
        showMessage("Support post created.");
      });
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  document.addEventListener("click", async (event) => {
    try {
      const appButton = event.target.closest("[data-action]");
      if (appButton) {
        await handleAppAction(appButton.dataset.action, appButton.dataset.id);
        return;
      }
      const reactionButton = event.target.closest("[data-support-reaction]");
      if (reactionButton) {
        await api(`/api/support/${reactionButton.dataset.id}/reactions`, {
          method: "POST",
          body: { reaction: reactionButton.dataset.supportReaction }
        });
        await loadAll();
        return;
      }
      const statusButton = event.target.closest("[data-support-status]");
      if (statusButton) {
        await api(`/api/support/${statusButton.dataset.id}/status`, {
          method: "PATCH",
          body: { status: statusButton.dataset.supportStatus }
        });
        await loadAll();
        return;
      }
      const approvalButton = event.target.closest("[data-admin-approval]");
      if (approvalButton) {
        await api(`/api/admin/apps/${approvalButton.dataset.id}/approval`, {
          method: "PATCH",
          body: { status: approvalButton.dataset.adminApproval, visibility: "public" }
        });
        await loadAll();
        showMessage("Approval updated.");
        return;
      }
      const copyButton = event.target.closest("[data-copy]");
      if (copyButton) {
        await copyText(copyButton.dataset.copy);
        showMessage("Path copied.");
      }
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  qs("#reconcileBtn").addEventListener("click", async () => {
    try {
      await api("/api/admin/reconcile", { method: "POST" });
      await loadAll();
      showMessage("Reconciled active jobs.");
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
  qs("#clearAppsBtn").addEventListener("click", async () => {
    try {
      const data = await api("/api/apps/clear", { method: "POST" });
      await loadAll();
      showMessage(`${data.cleared} app record${data.cleared === 1 ? "" : "s"} cleared.`);
    } catch (error) {
      showMessage(error.message, "error");
    }
  });
}

bindEvents();
setView("home");
loadAll().catch((error) => showMessage(error.message, "error"));
