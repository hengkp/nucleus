import { FileStore } from "./file-store.js";
import { PostgresStore } from "./postgres-store.js";
import { loadTemplateSeed } from "./templates.js";

export async function createStore(config) {
  const templateSeed = await loadTemplateSeed(config.templatePath);
  if (config.databaseUrl) {
    const pg = await import("pg");
    const store = new PostgresStore(config, templateSeed, pg);
    await store.init();
    return store;
  }
  const store = new FileStore(config, templateSeed);
  await store.init();
  return store;
}
