#!/usr/bin/env node
import http from "node:http";
import { watch } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadCompanyApplications,
  markApplicationApplied,
  markApplicationOutreachSent,
} from "./applications-data.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, "web");
const allowedDirs = [
  { dir: "interview-prep", category: "Prep" },
  { dir: "reports", category: "Report" },
  { dir: "output", category: "Output" },
];

const args = parseArgs(process.argv.slice(2));
const careerOpsPath = path.resolve(args.path || path.join(__dirname, ".."));
const startPort = Number.parseInt(args.port || process.env.PORT || "4176", 10);

const reloadClients = new Set();
let reloadTimer = null;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--path" && argv[i + 1]) {
      result.path = argv[++i];
    } else if (arg === "--port" && argv[i + 1]) {
      result.port = argv[++i];
    }
  }
  return result;
}

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(text);
}

function openReloadStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write("retry: 250\n\n");
  reloadClients.add(res);
  req.on("close", () => reloadClients.delete(res));
}

function broadcastReload() {
  for (const client of reloadClients) {
    try {
      client.write(`event: reload\ndata: ${Date.now()}\n\n`);
    } catch {
      reloadClients.delete(client);
    }
  }
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(broadcastReload, 75);
  reloadTimer.unref();
}

function watchForReload() {
  const targets = [
    { path: staticDir, recursive: true },
    { path: path.join(careerOpsPath, "data"), recursive: true },
    { path: path.join(careerOpsPath, "reports"), recursive: true },
    { path: path.join(careerOpsPath, "output"), recursive: true },
    { path: path.join(careerOpsPath, "interview-prep"), recursive: true },
    { path: path.join(careerOpsPath, "config"), recursive: true },
    { path: path.join(careerOpsPath, "applications.md"), recursive: false },
  ];

  for (const target of targets) {
    try {
      const watcher = watch(target.path, { recursive: target.recursive }, scheduleReload);
      watcher.on("error", (error) => console.error(`reload watcher: ${error.message}`));
      watcher.unref();
    } catch (error) {
      if (error.code !== "ENOENT") console.error(`reload watcher: ${error.message}`);
    }
  }
}

const reloadHeartbeat = setInterval(() => {
  for (const client of reloadClients) client.write(": keepalive\n\n");
}, 15_000);
reloadHeartbeat.unref();

function contentTypeFor(filePath) {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function markdownFilesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await markdownFilesUnder(entryPath));
    } else if (entry.isFile() && path.extname(entry.name) === ".md") {
      files.push(entryPath);
    }
  }
  return files;
}

async function listGeneratedFiles() {
  const files = [];

  for (const source of allowedDirs) {
    const markdownFiles = await markdownFilesUnder(path.join(careerOpsPath, source.dir));
    for (const absolutePath of markdownFiles) {
      const info = await stat(absolutePath);
      const relPath = path.relative(careerOpsPath, absolutePath);
      files.push({
        title: await markdownTitle(absolutePath, path.basename(absolutePath)),
        path: relPath.split(path.sep).join("/"),
        category: source.category,
        modified: info.mtime.toISOString(),
        size: info.size,
      });
    }
  }

  files.sort((a, b) => {
    const byDate = Date.parse(b.modified) - Date.parse(a.modified);
    if (byDate !== 0) return byDate;
    return a.path.localeCompare(b.path);
  });

  return files;
}

async function markdownTitle(filePath, fallback) {
  try {
    const content = await readFile(filePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("# ")) {
        return trimmed.slice(2).trim();
      }
    }
  } catch {
    // Fall through to filename.
  }
  return fallback.replace(/\.md$/i, "");
}

function resolveGeneratedMarkdown(relPath) {
  if (!relPath || path.isAbsolute(relPath)) {
    return null;
  }

  const normalized = path.normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const absolutePath = path.resolve(careerOpsPath, normalized);
  const relative = path.relative(careerOpsPath, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative) || path.extname(absolutePath) !== ".md") {
    return null;
  }

  const topLevel = relative.split(path.sep)[0];
  if (!allowedDirs.some((source) => source.dir === topLevel)) {
    return null;
  }

  return absolutePath;
}

async function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const clean = path.normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.resolve(staticDir, clean.replace(/^[/\\]/, ""));
  const relative = path.relative(staticDir, filePath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      "cache-control": "no-store",
    });
    res.end(content);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");

  try {
    if (url.pathname === "/api/reload") {
      openReloadStream(req, res);
      return;
    }
    if (url.pathname === "/api/files") {
      sendJSON(res, 200, { files: await listGeneratedFiles() });
      return;
    }

    const appliedMatch = /^\/api\/applications\/(\d+)\/applied$/.exec(url.pathname);
    if (req.method === "POST" && appliedMatch) {
      const applicationNumber = Number.parseInt(appliedMatch[1], 10);
      const result = await markApplicationApplied(careerOpsPath, applicationNumber);
      if (!result) {
        sendJSON(res, 404, { error: `Application #${applicationNumber} was not found` });
        return;
      }
      sendJSON(res, 200, { applicationNumber, ...result });
      return;
    }

    const outreachSentMatch = /^\/api\/applications\/(\d+)\/outreach-sent$/.exec(url.pathname);
    if (req.method === "POST" && outreachSentMatch) {
      const applicationNumber = Number.parseInt(outreachSentMatch[1], 10);
      const result = await markApplicationOutreachSent(careerOpsPath, applicationNumber);
      if (!result) {
        sendJSON(res, 404, { error: `Application #${applicationNumber} was not found` });
        return;
      }
      sendJSON(res, 200, { applicationNumber, ...result });
      return;
    }

    if (url.pathname === "/api/applications") {
      sendJSON(res, 200, await loadCompanyApplications(careerOpsPath));
      return;
    }

    if (url.pathname === "/api/file") {
      const relPath = url.searchParams.get("path");
      const filePath = resolveGeneratedMarkdown(relPath);
      if (!filePath) {
        sendJSON(res, 400, { error: "Invalid file path" });
        return;
      }
      const content = await readFile(filePath, "utf8");
      if (url.searchParams.get("raw") === "1") {
        sendText(res, 200, content, "text/markdown; charset=utf-8");
        return;
      }
      sendJSON(res, 200, { path: relPath, content });
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    sendJSON(res, 500, { error: error.message });
  }
}

function listen(port, attemptsLeft = 20, samePortRetries = 10) {
  const server = http.createServer(handleRequest);

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && samePortRetries > 0) {
      setTimeout(() => listen(port, attemptsLeft, samePortRetries - 1), 150);
      return;
    }
    if (error.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`port ${port} remained busy; trying ${port + 1}`);
      listen(port + 1, attemptsLeft - 1, 10);
      return;
    }
    console.error(error.message);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`career-ops web dashboard: http://127.0.0.1:${port}`);
    console.log(`serving generated files from: ${careerOpsPath}`);
  });
}

watchForReload();

listen(Number.isFinite(startPort) ? startPort : 4176);
