import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(64);
}

const templatePath = process.env.APPHUB_TEMPLATE_PATH || path.resolve("../runtime/templates.json");
const raw = JSON.parse(await readFile(templatePath, "utf8"));
const templates = Array.isArray(raw.templates) ? raw.templates : [];
if (!templates.length) {
  console.error(`No templates found in ${templatePath}.`);
  process.exit(65);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  for (const template of templates) {
    if (!template.id) continue;
    await pool.query(
      `insert into apphub_templates (id, enabled, data, updated_at)
       values ($1, $2, $3, now())
       on conflict (id) do update
       set enabled = excluded.enabled,
           data = excluded.data,
           updated_at = now()`,
      [template.id, template.enabled !== false, template]
    );
    console.log(`synced template ${template.id}`);
  }
} finally {
  await pool.end();
}
