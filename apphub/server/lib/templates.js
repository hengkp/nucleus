import { readFile } from "node:fs/promises";

export async function loadTemplateSeed(templatePath) {
  const raw = JSON.parse(await readFile(templatePath, "utf8"));
  if (!Array.isArray(raw.templates)) return [];
  return raw.templates.map((template) => ({
    environment: {},
    volumes: [],
    enabled: true,
    ...template
  }));
}

export function renderTemplateValue(value, context) {
  if (typeof value !== "string") return value;
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return context[key] === undefined ? match : String(context[key]);
  });
}

export function renderTemplate(template, context) {
  return {
    command: (template.command || []).map((item) => renderTemplateValue(item, context)),
    environment: Object.fromEntries(
      Object.entries(template.environment || {}).map(([key, value]) => [key, renderTemplateValue(value, context)])
    ),
    volumes: (template.volumes || []).map((volume) => ({
      source: renderTemplateValue(volume.source, context),
      target: renderTemplateValue(volume.target, context),
      mode: volume.mode || "rw"
    })),
    workingDirectory: renderTemplateValue(template.workingDirectory || "/workspace", context)
  };
}
