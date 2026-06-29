import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppServer } from "../server.js";

function request(baseUrl, pathname, { user = "alice", method = "GET", body } = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-remote-user": user
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  });
}

async function requestRaw(baseUrl, pathname, { user = "alice", method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-remote-user": user
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return {
    status: response.status,
    data: await response.json()
  };
}

test("mock AppHub API launch, route, support, approval, stop", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apphub-test-"));
  const apphubRoot = path.resolve("..");
  const server = await createAppServer({
    dataDir: temp,
    dataPath: path.join(temp, "apphub.json"),
    jobRoot: path.join(temp, "jobs"),
    logRoot: path.join(temp, "logs"),
    templatePath: path.join(apphubRoot, "runtime", "templates.json"),
    webRoot: path.join(apphubRoot, "web"),
    slurmMode: "mock",
    reconcileIntervalMs: 0,
    adminUsers: new Set(["admin"]),
    allowDevLogin: true
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await request(baseUrl, "/api/health");
    assert.equal(health.ok, true);

    const templates = await request(baseUrl, "/api/templates");
    assert.ok(templates.templates.some((template) => template.id === "static-html"));

    const launched = await request(baseUrl, "/api/apps", {
      method: "POST",
      body: {
        name: "CRC Dashboard",
        templateId: "static-html",
        cpus: 1,
        memoryGb: 1,
        timeLimitMinutes: 0,
        workspacePath: "projects/crc-dashboard",
        visibility: "private"
      }
    });
    assert.equal(launched.app.status, "running");
    assert.equal(launched.app.memoryMb, 1024);
    assert.equal(launched.app.timeLimitMinutes, 0);
    assert.match(launched.app.url, /^https:\/\/crc-dashboard-alice\.app\.sisp\.com/);

    const routes = await request(baseUrl, "/api/admin/routes", { user: "admin" });
    assert.equal(routes.routes.length, 1);
    assert.equal(routes.routes[0].targetPort, launched.app.port);

    const persistent = await request(baseUrl, `/api/apps/${launched.app.id}/persistence`, { method: "POST" });
    assert.equal(persistent.app.approvalStatus, "pending");

    const approved = await request(baseUrl, `/api/admin/apps/${launched.app.id}/approval`, {
      user: "admin",
      method: "PATCH",
      body: { status: "approved", visibility: "public" }
    });
    assert.equal(approved.app.approvalStatus, "approved");
    assert.equal(approved.app.visibility, "public");

    const support = await request(baseUrl, "/api/support", {
      method: "POST",
      body: {
        title: "App will not load",
        body: "The route returns a gateway error.",
        status: "admin-needed",
        appId: launched.app.id
      }
    });
    assert.equal(support.thread.status, "admin-needed");

    const reacted = await request(baseUrl, `/api/support/${support.thread.id}/reactions`, {
      method: "POST",
      body: { reaction: "same" }
    });
    assert.equal(reacted.thread.reactions.same, 1);

    const stopped = await request(baseUrl, `/api/apps/${launched.app.id}/stop`, { method: "POST" });
    assert.equal(stopped.app.status, "stopped");
    const routesAfterStop = await request(baseUrl, "/api/admin/routes", { user: "admin" });
    assert.equal(routesAfterStop.routes.length, 0);

    const cleared = await request(baseUrl, `/api/apps/${launched.app.id}/clear`, { method: "POST" });
    assert.equal(cleared.cleared, 1);
    const appsAfterClear = await request(baseUrl, "/api/apps");
    assert.equal(appsAfterClear.apps.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("user can clear stopped and failed app records in bulk", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apphub-test-"));
  const apphubRoot = path.resolve("..");
  const server = await createAppServer({
    dataDir: temp,
    dataPath: path.join(temp, "apphub.json"),
    jobRoot: path.join(temp, "jobs"),
    logRoot: path.join(temp, "logs"),
    templatePath: path.join(apphubRoot, "runtime", "templates.json"),
    webRoot: path.join(apphubRoot, "web"),
    slurmMode: "mock",
    reconcileIntervalMs: 0,
    allowDevLogin: true
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const launched = await request(baseUrl, "/api/apps", {
      method: "POST",
      body: {
        name: "Clear Me",
        templateId: "static-html",
        cpus: 1,
        memoryGb: 1,
        timeLimitMinutes: 0,
        workspacePath: "projects/clear-me",
        visibility: "private"
      }
    });
    await request(baseUrl, `/api/apps/${launched.app.id}/stop`, { method: "POST" });
    const cleared = await request(baseUrl, "/api/apps/clear", { method: "POST" });
    assert.equal(cleared.cleared, 1);
    const apps = await request(baseUrl, "/api/apps");
    assert.equal(apps.apps.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});

test("staged mode reports launch disabled instead of creating mock apps", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "apphub-test-"));
  const apphubRoot = path.resolve("..");
  const server = await createAppServer({
    dataDir: temp,
    dataPath: path.join(temp, "apphub.json"),
    jobRoot: path.join(temp, "jobs"),
    logRoot: path.join(temp, "logs"),
    templatePath: path.join(apphubRoot, "runtime", "templates.json"),
    webRoot: path.join(apphubRoot, "web"),
    slurmMode: "mock",
    allowMockLaunches: false,
    reconcileIntervalMs: 0,
    allowDevLogin: true
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const session = await request(baseUrl, "/api/session");
    assert.equal(session.runtime.launchesEnabled, false);
    assert.match(session.runtime.message, /temporarily disabled/);

    const launch = await requestRaw(baseUrl, "/api/apps", {
      method: "POST",
      body: {
        name: "Staged App",
        templateId: "static-html",
        cpus: 1,
        memoryGb: 1,
        timeLimitMinutes: 0,
        workspacePath: "projects/staged",
        visibility: "private"
      }
    });
    assert.equal(launch.status, 503);
    assert.match(launch.data.error, /temporarily disabled/);

    const apps = await request(baseUrl, "/api/apps");
    assert.equal(apps.apps.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});
