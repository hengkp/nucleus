import { randomUUID } from "node:crypto";
import { isActiveStatus } from "./validation.js";

function nowIso() {
  return new Date().toISOString();
}

function rowData(row) {
  return row.data;
}

export class PostgresStore {
  constructor(config, templateSeed, pgModule) {
    this.config = config;
    this.templateSeed = templateSeed;
    this.pool = new pgModule.Pool({ connectionString: config.databaseUrl });
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query("select 1 from apphub_templates limit 1");
      const { rows } = await client.query("select count(*)::int as count from apphub_templates");
      if (rows[0].count === 0) {
        for (const template of this.templateSeed) {
          await client.query(
            "insert into apphub_templates (id, enabled, data, updated_at) values ($1, $2, $3, now()) on conflict (id) do nothing",
            [template.id, template.enabled !== false, template]
          );
        }
      }
    } finally {
      client.release();
    }
  }

  async listTemplates({ includeDisabled = false } = {}) {
    const { rows } = await this.pool.query(
      `select data from apphub_templates
       where ($1::boolean or enabled)
       order by data->>'category', data->>'name'`,
      [includeDisabled]
    );
    return rows.map(rowData);
  }

  async getTemplate(id) {
    const { rows } = await this.pool.query("select data from apphub_templates where id = $1", [id]);
    return rows[0]?.data || null;
  }

  async upsertTemplate(template, actor) {
    const next = { ...template, updatedAt: nowIso(), updatedBy: actor };
    await this.pool.query(
      `insert into apphub_templates (id, enabled, data, updated_at)
       values ($1, $2, $3, now())
       on conflict (id) do update set enabled = excluded.enabled, data = excluded.data, updated_at = now()`,
      [next.id, next.enabled !== false, next]
    );
    await this.addAudit({ actor, action: "template.upsert", targetType: "template", targetId: next.id, data: next });
    return next;
  }

  async listApps({ user, includeAll = false } = {}) {
    const { rows } = await this.pool.query(
      `select data from apphub_apps
       where ($1::boolean or owner = $2)
       order by updated_at desc`,
      [includeAll, user || ""]
    );
    return rows.map(rowData);
  }

  async getApp(id) {
    const { rows } = await this.pool.query("select data from apphub_apps where id = $1", [id]);
    return rows[0]?.data || null;
  }

  async createApp(app) {
    await this.pool.query(
      `insert into apphub_apps
       (id, owner, status, port, route_host, slurm_job_id, data, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
      [app.id, app.owner, app.status, app.port, app.routeHost, app.slurmJobId, app]
    );
    return app;
  }

  async updateApp(id, patch) {
    const app = await this.getApp(id);
    if (!app) return null;
    const next = { ...app, ...patch, updatedAt: nowIso() };
    await this.pool.query(
      `update apphub_apps
       set status = $2, port = $3, route_host = $4, slurm_job_id = $5, data = $6, updated_at = now()
       where id = $1`,
      [id, next.status, next.port, next.routeHost, next.slurmJobId, next]
    );
    return next;
  }

  async deleteApp(id) {
    const app = await this.getApp(id);
    if (!app) return null;
    await this.pool.query("delete from apphub_apps where id = $1", [id]);
    return app;
  }

  async clearApps({ user, includeAll = false, statuses = ["stopped", "failed"] } = {}) {
    const { rows } = await this.pool.query(
      `delete from apphub_apps
       where ($1::boolean or owner = $2)
         and status = any($3::text[])
       returning data`,
      [includeAll, user || "", statuses]
    );
    return rows.map(rowData);
  }

  async allocatePort({ start, end }) {
    const { rows } = await this.pool.query("select port, status from apphub_apps where port between $1 and $2", [start, end]);
    const used = new Set(rows.filter((row) => isActiveStatus(row.status)).map((row) => Number(row.port)));
    const routeRows = await this.pool.query(
      "select target_port from apphub_routes where status = 'active' and target_port between $1 and $2",
      [start, end]
    );
    for (const row of routeRows.rows) used.add(Number(row.target_port));
    for (let port = start; port <= end; port += 1) {
      if (!used.has(port)) return port;
    }
    throw Object.assign(new Error("No free AppHub ports are available."), { statusCode: 409 });
  }

  async listRoutes() {
    const { rows } = await this.pool.query("select data from apphub_routes order by updated_at desc");
    return rows.map(rowData);
  }

  async upsertRoute(route) {
    const next = { ...route, updatedAt: nowIso() };
    await this.pool.query(
      `insert into apphub_routes (host, app_id, target_host, target_port, status, data, updated_at)
       values ($1, $2, $3, $4, $5, $6, now())
       on conflict (host) do update
       set app_id = excluded.app_id,
           target_host = excluded.target_host,
           target_port = excluded.target_port,
           status = excluded.status,
           data = excluded.data,
           updated_at = now()`,
      [next.host, next.appId, next.targetHost, next.targetPort, next.status, next]
    );
    return next;
  }

  async removeRoute(host) {
    await this.pool.query("delete from apphub_routes where host = $1", [host]);
  }

  async listSupport({ includeAll = true } = {}) {
    const { rows } = await this.pool.query(
      `select data from apphub_support_threads
       where ($1::boolean or status <> 'hidden')
       order by updated_at desc`,
      [includeAll]
    );
    return rows.map(rowData);
  }

  async createSupportThread(thread) {
    await this.pool.query(
      `insert into apphub_support_threads (id, status, data, created_at, updated_at)
       values ($1, $2, $3, now(), now())`,
      [thread.id, thread.status, thread]
    );
    return thread;
  }

  async updateSupportThread(id, updater) {
    const { rows } = await this.pool.query("select data from apphub_support_threads where id = $1", [id]);
    const thread = rows[0]?.data;
    if (!thread) return null;
    updater(thread);
    thread.updatedAt = nowIso();
    await this.pool.query(
      "update apphub_support_threads set status = $2, data = $3, updated_at = now() where id = $1",
      [id, thread.status, thread]
    );
    return thread;
  }

  async addAudit(event) {
    await this.pool.query(
      `insert into apphub_audit_events (id, actor, action, target_type, target_id, data, created_at)
       values ($1, $2, $3, $4, $5, $6, now())`,
      [
        randomUUID(),
        event.actor || "system",
        event.action,
        event.targetType,
        event.targetId,
        event.data || {}
      ]
    );
  }

  async listAudit(limit = 200) {
    const { rows } = await this.pool.query(
      "select id, actor, action, target_type as \"targetType\", target_id as \"targetId\", data, created_at as \"createdAt\" from apphub_audit_events order by created_at desc limit $1",
      [limit]
    );
    return rows;
  }
}
