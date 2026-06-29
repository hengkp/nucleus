import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isActiveStatus } from "./validation.js";

function nowIso() {
  return new Date().toISOString();
}

function sortByUpdated(items) {
  return [...items].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

export class FileStore {
  constructor(config, templateSeed) {
    this.config = config;
    this.templateSeed = templateSeed;
    this.cache = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await this.#load();
  }

  async #load() {
    if (this.cache) return this.cache;
    await mkdir(path.dirname(this.config.dataPath), { recursive: true });
    try {
      this.cache = JSON.parse(await readFile(this.config.dataPath, "utf8"));
    } catch {
      this.cache = this.#emptyData();
      await this.#save();
    }
    this.cache.templates ||= this.templateSeed;
    this.cache.apps ||= [];
    this.cache.routes ||= [];
    this.cache.supportThreads ||= [];
    this.cache.audit ||= [];
    return this.cache;
  }

  #emptyData() {
    return {
      version: 1,
      templates: this.templateSeed,
      apps: [],
      routes: [],
      supportThreads: [],
      audit: []
    };
  }

  async #save() {
    await mkdir(path.dirname(this.config.dataPath), { recursive: true });
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${this.config.dataPath}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(this.cache, null, 2), "utf8");
      await rename(tmp, this.config.dataPath);
    });
    return this.writeQueue;
  }

  async listTemplates({ includeDisabled = false } = {}) {
    const data = await this.#load();
    return data.templates.filter((template) => includeDisabled || template.enabled !== false);
  }

  async getTemplate(id) {
    const data = await this.#load();
    return data.templates.find((template) => template.id === id) || null;
  }

  async upsertTemplate(template, actor) {
    const data = await this.#load();
    const index = data.templates.findIndex((item) => item.id === template.id);
    const next = { ...template, updatedAt: nowIso(), updatedBy: actor };
    if (index === -1) data.templates.push(next);
    else data.templates[index] = { ...data.templates[index], ...next };
    await this.addAudit({ actor, action: "template.upsert", targetType: "template", targetId: template.id, data: next });
    await this.#save();
    return next;
  }

  async listApps({ user, includeAll = false } = {}) {
    const data = await this.#load();
    const apps = includeAll ? data.apps : data.apps.filter((app) => app.owner === user);
    return sortByUpdated(apps);
  }

  async getApp(id) {
    const data = await this.#load();
    return data.apps.find((app) => app.id === id) || null;
  }

  async createApp(app) {
    const data = await this.#load();
    data.apps.push(app);
    await this.#save();
    return app;
  }

  async updateApp(id, patch) {
    const data = await this.#load();
    const index = data.apps.findIndex((app) => app.id === id);
    if (index === -1) return null;
    data.apps[index] = { ...data.apps[index], ...patch, updatedAt: nowIso() };
    await this.#save();
    return data.apps[index];
  }

  async deleteApp(id) {
    const data = await this.#load();
    const app = data.apps.find((item) => item.id === id);
    if (!app) return null;
    data.apps = data.apps.filter((item) => item.id !== id);
    data.routes = data.routes.filter((route) => route.appId !== id && route.host !== app.routeHost);
    await this.#save();
    return app;
  }

  async clearApps({ user, includeAll = false, statuses = ["stopped", "failed"] } = {}) {
    const data = await this.#load();
    const statusSet = new Set(statuses);
    const removed = data.apps.filter((app) => (includeAll || app.owner === user) && statusSet.has(app.status));
    const removedIds = new Set(removed.map((app) => app.id));
    const removedHosts = new Set(removed.map((app) => app.routeHost).filter(Boolean));
    data.apps = data.apps.filter((app) => !removedIds.has(app.id));
    data.routes = data.routes.filter((route) => !removedIds.has(route.appId) && !removedHosts.has(route.host));
    await this.#save();
    return removed;
  }

  async allocatePort({ start, end }) {
    const data = await this.#load();
    const used = new Set();
    for (const app of data.apps) {
      if (app.port && isActiveStatus(app.status)) used.add(Number(app.port));
    }
    for (const route of data.routes) {
      if (route.targetPort && route.status === "active") used.add(Number(route.targetPort));
    }
    for (let port = start; port <= end; port += 1) {
      if (!used.has(port)) return port;
    }
    throw Object.assign(new Error("No free AppHub ports are available."), { statusCode: 409 });
  }

  async listRoutes() {
    const data = await this.#load();
    return sortByUpdated(data.routes);
  }

  async upsertRoute(route) {
    const data = await this.#load();
    const index = data.routes.findIndex((item) => item.host === route.host);
    const next = { ...route, updatedAt: nowIso() };
    if (index === -1) data.routes.push(next);
    else data.routes[index] = { ...data.routes[index], ...next };
    await this.#save();
    return next;
  }

  async removeRoute(host) {
    const data = await this.#load();
    data.routes = data.routes.filter((route) => route.host !== host);
    await this.#save();
  }

  async listSupport({ includeAll = true } = {}) {
    const data = await this.#load();
    return sortByUpdated(data.supportThreads).filter((thread) => includeAll || thread.status !== "hidden");
  }

  async createSupportThread(thread) {
    const data = await this.#load();
    data.supportThreads.push(thread);
    await this.#save();
    return thread;
  }

  async updateSupportThread(id, updater) {
    const data = await this.#load();
    const thread = data.supportThreads.find((item) => item.id === id);
    if (!thread) return null;
    updater(thread);
    thread.updatedAt = nowIso();
    await this.#save();
    return thread;
  }

  async addAudit(event) {
    const data = await this.#load();
    data.audit.push({
      id: randomUUID(),
      createdAt: nowIso(),
      actor: event.actor || "system",
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      data: event.data || {}
    });
    if (data.audit.length > 2000) data.audit = data.audit.slice(-2000);
    await this.#save();
  }

  async listAudit(limit = 200) {
    const data = await this.#load();
    return sortByUpdated(data.audit).slice(0, limit);
  }
}
