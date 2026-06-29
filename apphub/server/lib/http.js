import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"]
]);

export function jsonResponse(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

export function textResponse(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(value);
}

export async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

export async function serveStatic(req, res, url, webRoot) {
  const rawPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = path.resolve(webRoot, `.${rawPath}`);
  const root = path.resolve(webRoot);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    return textResponse(res, 403, "Forbidden");
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) return textResponse(res, 404, "Not found");
    res.writeHead(200, { "Content-Type": mimeTypes.get(path.extname(target)) || "application/octet-stream" });
    createReadStream(target).pipe(res);
  } catch {
    return textResponse(res, 404, "Not found");
  }
}
