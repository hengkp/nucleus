import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8791);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dataPath = path.join(dataDir, "support.json");
const webRoot = process.env.WEB_ROOT || path.resolve(__dirname, "..", "web");
const maxBodyBytes = 64 * 1024;

let cache = null;
let writeQueue = Promise.resolve();

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function textResponse(res, status, value) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(value);
}

function cleanText(value, limit) {
  return String(value ?? "").replace(/\r/g, "").trim().slice(0, limit);
}

async function loadData() {
  if (cache) return cache;
  await mkdir(dataDir, { recursive: true });
  try {
    cache = JSON.parse(await readFile(dataPath, "utf8"));
  } catch {
    cache = { threads: [] };
    await saveData();
  }
  if (!Array.isArray(cache.threads)) cache.threads = [];
  return cache;
}

async function saveData() {
  await mkdir(dataDir, { recursive: true });
  writeQueue = writeQueue.then(async () => {
    const tmp = `${dataPath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await rename(tmp, dataPath);
  });
  return writeQueue;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicThread(thread) {
  return {
    id: thread.id,
    title: thread.title,
    author: thread.author,
    share: thread.share,
    body: thread.body,
    status: thread.status,
    reactions: thread.reactions || {},
    replies: thread.replies || [],
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

async function handleApi(req, res, url) {
  const data = await loadData();

  if (req.method === "GET" && url.pathname === "/api/health") {
    return jsonResponse(res, 200, { ok: true, service: "sisp-mapdrive" });
  }

  if (req.method === "GET" && url.pathname === "/api/support") {
    const threads = [...data.threads]
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
      .map(publicThread);
    return jsonResponse(res, 200, { threads });
  }

  if (req.method === "POST" && url.pathname === "/api/support") {
    const body = await readJsonBody(req);
    const title = cleanText(body.title, 120);
    const author = cleanText(body.author, 80);
    const message = cleanText(body.body, 2000);
    if (!title || !author || !message) {
      return jsonResponse(res, 400, { error: "Title, author, and details are required." });
    }

    const now = new Date().toISOString();
    const thread = {
      id: randomUUID(),
      title,
      author,
      share: cleanText(body.share, 80) || "General",
      body: message,
      status: body.status === "solved" ? "solved" : "open",
      reactions: { same: 0, helpful: 0, thanks: 0 },
      replies: [],
      createdAt: now,
      updatedAt: now,
    };
    data.threads.push(thread);
    await saveData();
    return jsonResponse(res, 201, { thread: publicThread(thread) });
  }

  const replyMatch = url.pathname.match(/^\/api\/support\/([^/]+)\/replies$/);
  if (req.method === "POST" && replyMatch) {
    const thread = data.threads.find((item) => item.id === replyMatch[1]);
    if (!thread) return jsonResponse(res, 404, { error: "Thread not found." });
    const body = await readJsonBody(req);
    const author = cleanText(body.author, 80);
    const message = cleanText(body.body, 1000);
    if (!author || !message) return jsonResponse(res, 400, { error: "Reply author and message are required." });
    const now = new Date().toISOString();
    thread.replies ||= [];
    thread.replies.push({ id: randomUUID(), author, body: message, createdAt: now });
    thread.updatedAt = now;
    await saveData();
    return jsonResponse(res, 201, { thread: publicThread(thread) });
  }

  const reactionMatch = url.pathname.match(/^\/api\/support\/([^/]+)\/reactions$/);
  if (req.method === "POST" && reactionMatch) {
    const thread = data.threads.find((item) => item.id === reactionMatch[1]);
    if (!thread) return jsonResponse(res, 404, { error: "Thread not found." });
    const body = await readJsonBody(req);
    const reaction = cleanText(body.reaction, 24);
    if (!["same", "helpful", "thanks"].includes(reaction)) return jsonResponse(res, 400, { error: "Invalid reaction." });
    thread.reactions ||= { same: 0, helpful: 0, thanks: 0 };
    thread.reactions[reaction] = Number(thread.reactions[reaction] || 0) + 1;
    thread.updatedAt = new Date().toISOString();
    await saveData();
    return jsonResponse(res, 200, { thread: publicThread(thread) });
  }

  const statusMatch = url.pathname.match(/^\/api\/support\/([^/]+)\/status$/);
  if (req.method === "PATCH" && statusMatch) {
    const thread = data.threads.find((item) => item.id === statusMatch[1]);
    if (!thread) return jsonResponse(res, 404, { error: "Thread not found." });
    const body = await readJsonBody(req);
    thread.status = body.status === "solved" ? "solved" : "open";
    thread.updatedAt = new Date().toISOString();
    await saveData();
    return jsonResponse(res, 200, { thread: publicThread(thread) });
  }

  return jsonResponse(res, 404, { error: "Not found." });
}

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".exe", "application/octet-stream"],
  [".zip", "application/zip"],
]);

async function serveStatic(req, res, url) {
  const rawPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const target = path.resolve(webRoot, `.${rawPath}`);
  if (!target.startsWith(path.resolve(webRoot))) {
    return textResponse(res, 403, "Forbidden");
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) return textResponse(res, 404, "Not found");
    const ext = path.extname(target);
    res.writeHead(200, { "Content-Type": mimeTypes.get(ext) || "application/octet-stream" });
    createReadStream(target).pipe(res);
  } catch {
    return textResponse(res, 404, "Not found");
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    return jsonResponse(res, 500, { error: error.message || "Server error." });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`sisp-mapdrive server listening on 127.0.0.1:${port}`);
});
