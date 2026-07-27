// ============================================================================
// HELPERS
// ============================================================================
const jsonOk = (data) => Response.json(data);
const jsonError = (msg, status = 400) =>
  Response.json({ error: msg }, { status });
async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
function baseName(key) {
  return key.split("/").filter(Boolean).pop() || key;
}
function decodeRequestValue(value) {
  if (!value) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function ensureLeadingSlash(value) {
  return normalizeStoragePath(value);
}
import {
  fetch_webdav,
  normalizeStoragePath,
  normalizeStorageKey,
  joinStoragePath,
  ensureR2CompatibleStorage,
  getParentPath,
} from "./webdav.js";

// ============================================================================
// MAIN WORKER
// ============================================================================

async function ensureWorkerStorage(env) {
  if (env && env.WEBDAV_STORAGE) {
    ensureR2CompatibleStorage(env);
  }
}

async function createWebDAVUploadPathMarkers(env, filePath) {
  const now = new Date().toISOString();
  let dir = getParentPath(filePath);
  while (dir && dir !== "/") {
    await env.WEBDAV_STORAGE.put(
      `${dir}_dir`,
      JSON.stringify({
        type: "directory",
        createdAt: now,
        modifiedAt: now,
      }),
    );
    dir = getParentPath(dir);
  }
  await env.WEBDAV_STORAGE.put(
    `/_dir`,
    JSON.stringify({
      type: "directory",
      createdAt: now,
      modifiedAt: now,
    }),
  );
}

async function fetch_api(request, env) {
  try {
    await ensureWorkerStorage(env);
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // --- Serve frontend ---
    if (path === "/api/" || path === "/api/index.html")
      return env.ASSETS.fetch(request);

    // --- Public share (no auth) ---
    if (path.startsWith("/s/")) return handlePublicShare(url, env);

    // --- Auth gate for everything else ---
    const authKey = env.AUTH_KEY || env.APIKEYSECRET;
    if (authKey) {
      const k = url.searchParams.get("key") || request.headers.get("x-api-key");
      if (k !== authKey) return jsonError("Unauthorized", 401);
    }

    // --- File routes ---
    if (path === "/api/files" && method === "GET")
      return handleListFiles(url, env);

    if (path === "/api/files/info" && method === "GET") {
      const key = normalizeStoragePath(url.searchParams.get("key") || "");
      if (!key || key === "/") return jsonError("Missing key");
      const head = await env.WEBDAV_STORAGE.head(key);
      if (!head) return jsonError("Not found", 404);
      return jsonOk({
        key: head.key,
        size: head.size,
        uploaded: head.uploaded,
        httpMetadata: head.httpMetadata,
        customMetadata: head.customMetadata,
      });
    }

    if (path === "/api/files/delete" && method === "POST") {
      const body = await readBody(request);
      if (!body) return jsonError("Invalid body");
      const keys = Array.isArray(body.keys)
        ? body.keys
        : body.filename
          ? [body.filename]
          : [];
      if (!keys.length) return jsonError("No keys");
      // Also delete associated .folder markers if deleting folders
      await Promise.all(keys.map((k) => Promise.all([
        env.WEBDAV_STORAGE.delete(k),
        env.WEBDAV_STORAGE.delete(`${k}_meta`),
      ])));
      return jsonOk({ deleted: keys.length });
    }

    if (path === "/api/files/rename" && method === "POST") {
      const body = await readBody(request);
      if (!body?.oldName || !body?.newName) return jsonError("Missing params");
      const oldName = normalizeStoragePath(body.oldName);
      const newName = normalizeStoragePath(body.newName);
      const src = await env.WEBDAV_STORAGE.get(oldName);
      if (!src) return jsonError("Not found", 404);
      if (await env.WEBDAV_STORAGE.head(newName))
        return jsonError("Name already taken", 409);
      const srcBody = await src.arrayBuffer();
      await env.WEBDAV_STORAGE.put(newName, srcBody, {
        httpMetadata: src.httpMetadata,
        customMetadata: src.customMetadata,
      });
      const srcMeta = await env.WEBDAV_STORAGE.get(`${oldName}_meta`);
      if (srcMeta) {
        await env.WEBDAV_STORAGE.put(`${newName}_meta`, await srcMeta.text());
        await env.WEBDAV_STORAGE.delete(`${oldName}_meta`);
      }
      await env.WEBDAV_STORAGE.delete(oldName);
      return jsonOk({ status: "renamed", oldName, newName });
    }

    if (path === "/api/files/move" && method === "POST") {
      const body = await readBody(request);
      if (!body?.source || !body?.destination)
        return jsonError("Missing source or destination");
      const source = normalizeStoragePath(body.source);
      const destination = normalizeStoragePath(body.destination);
      const src = await env.WEBDAV_STORAGE.get(source);
      if (!src) return jsonError("Source not found", 404);
      const destKey = destination.endsWith("/")
        ? destination + source.split("/").pop()
        : destination;
      if (await env.WEBDAV_STORAGE.head(destKey))
        return jsonError("Destination already exists", 409);
      const srcBody = await src.arrayBuffer();
      await env.WEBDAV_STORAGE.put(destKey, srcBody, {
        httpMetadata: src.httpMetadata,
        customMetadata: src.customMetadata,
      });
      const srcMeta = await env.WEBDAV_STORAGE.get(`${source}_meta`);
      if (srcMeta) {
        await env.WEBDAV_STORAGE.put(`${destKey}_meta`, await srcMeta.text());
        await env.WEBDAV_STORAGE.delete(`${source}_meta`);
      }
      await env.WEBDAV_STORAGE.delete(source);
      return jsonOk({ status: "moved", source, destination: destKey });
    }

    if (path === "/api/files/copy" && method === "POST") {
      const body = await readBody(request);
      if (!body?.source || !body?.destination)
        return jsonError("Missing source or destination");
      const source = normalizeStoragePath(body.source);
      const destination = normalizeStoragePath(body.destination);
      const src = await env.WEBDAV_STORAGE.get(source);
      if (!src) return jsonError("Source not found", 404);
      const destKey = destination.endsWith("/")
        ? destination + source.split("/").pop()
        : destination;
      if (await env.WEBDAV_STORAGE.head(destKey))
        return jsonError("Destination already exists", 409);
      const srcBody = await src.arrayBuffer();
      await env.WEBDAV_STORAGE.put(destKey, srcBody, {
        httpMetadata: src.httpMetadata,
        customMetadata: src.customMetadata,
      });
      const srcMeta = await env.WEBDAV_STORAGE.get(`${source}_meta`);
      if (srcMeta) {
        await env.WEBDAV_STORAGE.put(`${destKey}_meta`, await srcMeta.text());
      }
      return jsonOk({ status: "copied", source, destination: destKey });
    }

    if (path === "/api/files/mkdir" && method === "POST") {
      const body = await readBody(request);
      if (!body?.path) return jsonError("Missing path");
      const folderPath = normalizeStoragePath(body.path);
      const folderKey =
        folderPath === "/"
          ? "/"
          : folderPath.endsWith("/")
            ? folderPath
            : folderPath + "/";
      const markerKey =
        folderKey === "/"
          ? "/.emptydir"
          : joinStoragePath(folderKey, ".emptydir");
      await env.WEBDAV_STORAGE.put(markerKey, new Uint8Array(0), {
        customMetadata: { type: "folder" },
      });
      return jsonOk({ created: folderKey });
    }

    if (path === "/api/upload" && (method === "PUT" || method === "POST")) {
      let filename = decodeRequestValue(url.searchParams.get("filename") || "");
      if (!filename) return jsonError("Missing filename");
      filename = ensureLeadingSlash(filename);

      const contentType =
        request.headers.get("Content-Type") || "application/octet-stream";

      const arrayBuffer = await request.arrayBuffer();
      const body = new Uint8Array(arrayBuffer);

      await env.WEBDAV_STORAGE.put(filename, body, {
        httpMetadata: { contentType, contentLength: body.length },
        customMetadata: { source: "upload", timestamp: Date.now().toString() },
      });

      const now = new Date().toISOString();
      await env.WEBDAV_STORAGE.put(
        `${filename}_meta`,
        JSON.stringify({
          type: "file",
          size: body.length,
          modifiedAt: now,
          contentType,
        }),
      );
      await createWebDAVUploadPathMarkers(env, filename);

      return jsonOk({ status: "uploaded", filename, size: body.length });
    }

    if (path.startsWith("/get/")) {
      let filename = decodeRequestValue(path.slice(5));
      filename = ensureLeadingSlash(filename);
      const obj = await env.WEBDAV_STORAGE.get(filename);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: getDownloadHeaders(obj, filename),
      });
    }

    // --- Job routes ---
    if (path === "/api/jobs/init" && method === "POST") {
      const body = await readBody(request);
      if (!body?.sourceUrl || !body?.filename)
        return jsonError("Missing sourceUrl or filename");
      let filename = normalizeStoragePath(body.filename);
      if (!body.force) {
        const existing = await env.WEBDAV_STORAGE.head(filename);
        if (existing)
          return jsonOk({ status: "exists", filename, size: existing.size });
      }
      const jobId = crypto.randomUUID();
      const id = env.DOWNLOAD_MANAGER.idFromName(jobId);
      return env.DOWNLOAD_MANAGER.get(id).fetch(
        new Request("https://do/init", {
          method: "POST",
          body: JSON.stringify({ sourceUrl: body.sourceUrl, filename, jobId }),
        }),
      );
    }

    if (path === "/api/jobs/chunk" && method === "POST") {
      const body = await readBody(request);
      if (!body?.jobId) return jsonError("Missing jobId");
      const id = env.DOWNLOAD_MANAGER.idFromName(body.jobId);
      return env.DOWNLOAD_MANAGER.get(id).fetch(
        new Request("https://do/chunk", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    }

    if (path === "/api/jobs/status" && method === "POST") {
      const body = await readBody(request);
      if (!body?.jobId) return jsonError("Missing jobId");
      const id = env.DOWNLOAD_MANAGER.idFromName(body.jobId);
      return env.DOWNLOAD_MANAGER.get(id).fetch(
        new Request("https://do/status"),
      );
    }

    if (path === "/api/jobs/finish" && method === "POST") {
      const body = await readBody(request);
      if (!body?.jobId) return jsonError("Missing jobId");
      const id = env.DOWNLOAD_MANAGER.idFromName(body.jobId);
      return env.DOWNLOAD_MANAGER.get(id).fetch(
        new Request("https://do/finish", { method: "POST" }),
      );
    }

    if (path === "/api/jobs/abort" && method === "POST") {
      const body = await readBody(request);
      if (!body?.jobId) return jsonError("Missing jobId");
      const id = env.DOWNLOAD_MANAGER.idFromName(body.jobId);
      return env.DOWNLOAD_MANAGER.get(id).fetch(
        new Request("https://do/abort", { method: "POST" }),
      );
    }

    // --- Share routes ---
    if (path === "/api/shares" && method === "GET")
      return handleListShares(env);
    if (path === "/api/shares/create" && method === "POST")
      return handleCreateShare(request, env);
    if (path === "/api/shares/revoke" && method === "POST") {
      const body = await readBody(request);
      if (!body?.token) return jsonError("Missing token");
      await env.WEBDAV_STORAGE.delete(`.tokens/${body.token}`);
      return jsonOk({ revoked: true });
    }

    return jsonError("Not Found: " + path, 404);
  } catch (e) {
    return jsonError("Internal Error: " + e.message, 500);
  }
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      console.log("Incoming request:", { method, path,request });

      // --- Public share (no auth) ---
      if (path.startsWith("/s/")) return handlePublicShare(url, env);

      //-- API
      if (path.startsWith("/api")) return fetch_api(request, env);

      if (
        (path === "/" || path === "/index.html") &&
        ["GET", "HEAD"].includes(method)
      ) {
        return env.ASSETS.fetch(request);
      }


      


      //-- Webdav
      if (path.startsWith("/")) return fetch_webdav(request, env);

      return jsonError("Not Found: " + path, 404);
    } catch (e) {
      return jsonError("Internal Error: " + e.message, 500);
    }
  },
};

// ============================================================================
// Route Handlers
// ============================================================================
async function handlePublicShare(url, env) {
  const code = url.searchParams.get("code") || "";
  const token = url.pathname.split("/")[2];
  if (!token) return new Response("Missing token", { status: 400 });
  const tokenObj = await env.WEBDAV_STORAGE.get(`.tokens/${token}`);
  if (!tokenObj)
    return new Response("Invalid or expired link", { status: 404 });
  const meta = await tokenObj.json();
  if (meta.expires && Date.now() > meta.expires) {
    await env.WEBDAV_STORAGE.delete(`.tokens/${token}`);
    return new Response("Link expired", { status: 410 });
  }
  if (code !== meta.code) return new Response("Invalid code", { status: 403 });
  const filename = normalizeStoragePath(meta.filename);
  const obj = await env.WEBDAV_STORAGE.get(filename);
  if (!obj) return new Response("File not found", { status: 404 });
  return new Response(obj.body, { headers: getDownloadHeaders(obj, filename) });
}

async function handleListFiles(url, env) {
  const prefix = ensureLeadingSlash(
    decodeRequestValue(url.searchParams.get("prefix") || ""),
  );
  const delimiter = url.searchParams.get("delimiter") || "";
  const cursor = url.searchParams.get("cursor") || undefined;
  const search = (url.searchParams.get("search") || "").toLowerCase();
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "500"),
    1000,
  );

  const normalizedPrefix = prefix === "/" ? "/" : normalizeStoragePath(prefix);
  let storagePrefix =
    normalizedPrefix === "/"
      ? undefined
      : normalizeStorageKey(normalizedPrefix);
  if (storagePrefix && delimiter && !storagePrefix.endsWith("/")) {
    storagePrefix += "/";
  }
  const baseOpts = { limit, include: ["customMetadata", "httpMetadata"] };
  if (storagePrefix) baseOpts.prefix = storagePrefix;
  if (delimiter) baseOpts.delimiter = delimiter;
  if (cursor) baseOpts.cursor = cursor;

  const listed = await env.WEBDAV_STORAGE.list(baseOpts);
  let listedFallback = null;
  if (
    normalizedPrefix === "/" &&
    delimiter === "/" &&
    (!listed.objects?.length || listed.objects.length === 0) &&
    (!listed.delimitedPrefixes?.length || listed.delimitedPrefixes.length === 0)
  ) {
    listedFallback = await env.WEBDAV_STORAGE.list({
      limit,
      include: ["customMetadata", "httpMetadata"],
    });
  }

  const collectedObjects = [];
  const collectedPrefixes = [];
  const seenKeys = new Set();

  for (const result of [listed, listedFallback].filter(Boolean)) {
    for (const object of result.objects || []) {
      const key = normalizeStoragePath(object.key);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      collectedObjects.push({ ...object, key });
    }
    for (const prefixCandidate of result.delimitedPrefixes || []) {
      const normalizedCandidate = normalizeStoragePath(prefixCandidate);
      if (
        normalizedCandidate &&
        normalizedCandidate !== "/" &&
        !normalizedCandidate.startsWith(".")
      ) {
        collectedPrefixes.push(
          normalizedCandidate.endsWith("/")
            ? normalizedCandidate
            : `${normalizedCandidate}/`,
        );
      }
    }
  }

  const fileEntries = [];
  const folderSet = new Set(collectedPrefixes);

  for (const object of collectedObjects) {
    const key = object.key;
    if (
      !key ||
      key === "/" ||
      key.startsWith(".tokens/") ||
      key.startsWith(".jobs/")
    )
      continue;
    if (
      key.endsWith(".emptydir") ||
      key.endsWith("_meta") ||
      key.endsWith("_dir")
    )
      continue;

    const displayKey = normalizeStoragePath(key);
    const relative = displayKey.startsWith(normalizedPrefix)
      ? displayKey.slice(normalizedPrefix.length)
      : displayKey;
    const segments = relative.split("/").filter(Boolean);

    if (segments.length > 1) {
      const childFolder =
        normalizedPrefix === "/"
          ? normalizeStoragePath(`/${segments[0]}`)
          : normalizeStoragePath(`${normalizedPrefix}/${segments[0]}`);
      folderSet.add(
        childFolder.endsWith("/") ? childFolder : `${childFolder}/`,
      );
      continue;
    }

    if (segments.length === 1) {
      fileEntries.push({
        key,
        size: object.size,
        uploaded: object.uploaded,
        httpMetadata: object.httpMetadata || {},
        customMetadata: object.customMetadata || {},
      });
    }
  }

  let files = fileEntries;
  if (search) files = files.filter((f) => f.key.toLowerCase().includes(search));

  const folders = Array.from(folderSet)
    .filter((folder) => folder && folder !== "/" && !folder.startsWith("."))
    .sort((a, b) => a.localeCompare(b));

    console.log("list files search:",search);
    console.log("list files:",files);

  return jsonOk({
    files,
    folders,
    truncated: false,
    cursor: null,
  });
}

async function handleListShares(env) {
  const listed = await env.WEBDAV_STORAGE.list({
    prefix: ".tokens/",
    limit: 200,
  });
  const shares = [];
  for (const obj of listed.objects) {
    try {
      const raw = await env.WEBDAV_STORAGE.get(obj.key);
      const data = await raw.json();
      const token = obj.key.replace(".tokens/", "");
      shares.push({
        token,
        filename: data.filename,
        code: data.code,
        expires: data.expires,
        created: data.created,
        expired: data.expires ? Date.now() > data.expires : false,
        url: `/s/${token}?code=${data.code}`,
      });
    } catch {}
  }
  return jsonOk({ shares });
}

async function handleCreateShare(request, env) {
  const body = await readBody(request);
  if (!body?.filename) return jsonError("Missing filename");
  const hours = parseInt(body.hours ?? 24);
  const customCode = (body.customCode || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "");
  const code =
    customCode || crypto.randomUUID().replace(/-/g, "").substring(0, 8);
  const expires = hours >= 999 ? null : Date.now() + hours * 3600000;
  const token = btoa(body.filename)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  await env.WEBDAV_STORAGE.put(
    `.tokens/${token}`,
    JSON.stringify({
      filename: body.filename,
      expires,
      code,
      created: Date.now(),
    }),
  );
  return jsonOk({
    token,
    code,
    url: `/s/${token}?code=${code}`,
    expires: expires ? new Date(expires).toISOString() : null,
  });
}

function getDownloadHeaders(obj, filename) {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set(
    "Content-Disposition",
    `attachment; filename="${baseName(filename)}"`,
  );
  headers.set("Content-Length", String(obj.size));
  headers.set("Cache-Control", "no-store");
  return headers;
}

// ============================================================================
// DURABLE OBJECT: DownloadManager
// ============================================================================
export class DownloadManager {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cpuStart = performance.now();
    try {
      switch (url.pathname) {
        case "/init":
          return await this.doInit(request);
        case "/chunk":
          return await this.doChunk(request, cpuStart);
        case "/finish":
          return await this.doFinish();
        case "/status":
          return await this.doStatus();
        case "/abort":
          return await this.doAbort();
        default:
          return jsonError("Unknown DO route", 404);
      }
    } catch (e) {
      return jsonError("DO error: " + e.message, 500);
    }
  }

  async doInit(request) {
    const { sourceUrl, filename, jobId } = await request.json();
    const CHUNK = 20 * 1024 * 1024;

    let head = null;
    let totalSize = 0;
    let contentType = "application/octet-stream";
    let rangeOk = false;

    try {
      head = await fetch(sourceUrl, { method: "HEAD" });
      if (head.ok) {
        totalSize = parseInt(head.headers.get("content-length")) || 0;
        contentType = head.headers.get("content-type") || contentType;
        rangeOk = head.headers.get("accept-ranges") === "bytes";
      }
    } catch (e) {
      console.warn("doInit HEAD failed:", e.message);
    }

    console.log("doInit, url: ", sourceUrl);
    console.log("doInit, filename: ", filename);
    console.log("doInit, jobId: ", jobId);
    console.log("doInit, head.ok: ", head?.ok);
    console.log("doInit, rangeOk: ", rangeOk);
    console.log("doInit, totalSize: ", totalSize);

    if (!rangeOk && totalSize > 0) {
      try {
        const probe = await fetch(sourceUrl, {
          headers: { Range: "bytes=0-0" },
        });
        if (probe.status === 206) {
          rangeOk = true;
          const rangeHeader = probe.headers.get("content-range") || "";
          const sizeMatch = rangeHeader.match(/\/(\d+)$/);
          if (sizeMatch) totalSize = Number(sizeMatch[1]);
        }
      } catch (e) {
        console.warn("doInit range probe failed:", e.message);
      }
    }

    if (!rangeOk && totalSize === 0) {
      try {
        const probe = await fetch(sourceUrl, {
          headers: { Range: "bytes=0-0" },
        });
        if (probe.ok) {
          const rangeHeader = probe.headers.get("content-range") || "";
          const sizeMatch = rangeHeader.match(/\/(\d+)$/);
          if (sizeMatch) {
            totalSize = Number(sizeMatch[1]);
            rangeOk = probe.status === 206;
          } else {
            const contentLength =
              parseInt(probe.headers.get("content-length")) || 0;
            if (contentLength > 0) {
              totalSize = contentLength;
              rangeOk = probe.status === 206;
            }
          }
        }
      } catch (e) {
        console.warn("doInit fallback probe failed:", e.message);
      }
    }

    if (!rangeOk || totalSize === 0 || totalSize < CHUNK) {
      await this.state.storage.put("status", {
        mode: "single",
        status: "downloading",
        filename,
        totalSize,
        started: Date.now(),
      });
      this.state.waitUntil(this.singleStream(sourceUrl, filename, contentType));
      return jsonOk({ mode: "single", totalSize, jobId });
    }

    const mp = await this.env.WEBDAV_STORAGE.createMultipartUpload(filename, {
      httpMetadata: { contentType },
      customMetadata: { source: sourceUrl, timestamp: Date.now().toString() },
    });

    const ranges = [];
    let s = 0,
      p = 1;
    while (s < totalSize) {
      const e = Math.min(s + CHUNK - 1, totalSize - 1);
      ranges.push({ partNumber: p++, start: s, end: e });
      s += CHUNK;
    }

    await this.state.storage.put("job", {
      uploadId: mp.uploadId,
      filename,
      sourceUrl,
      totalSize,
      totalParts: ranges.length,
    });
    await this.state.storage.put("status", {
      mode: "parallel",
      status: "downloading",
      filename,
      totalSize,
      totalParts: ranges.length,
      completedParts: 0,
      bytesDownloaded: 0,
      started: Date.now(),
    });

    return jsonOk({ mode: "parallel", totalSize, ranges, jobId });
  }

  async doChunk(request, cpuStart) {
    try {
      const { partNumber, start, end } = await request.json();
      const job = await this.state.storage.get("job");
      if (!job) return jsonOk({ status: "failed", error: "No active job" });
      if (await this.state.storage.get("aborted"))
        return jsonOk({ status: "failed", error: "Job aborted" });

      const mp = this.env.WEBDAV_STORAGE.resumeMultipartUpload(
        job.filename,
        job.uploadId,
      );
      const res = await fetch(job.sourceUrl, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      if (res.status !== 206 && res.status !== 200) {
        return jsonOk({
          status: "failed",
          error: "Range request failed: " + res.status,
        });
      }

      const part = await mp.uploadPart(partNumber, res.body);
      await this.state.storage.put(`part_${partNumber}`, {
        partNumber,
        etag: part.etag,
      });

      const chunkSize = end - start + 1;
      const status = await this.state.storage.get("status");
      if (status) {
        status.completedParts = (status.completedParts || 0) + 1;
        status.bytesDownloaded = (status.bytesDownloaded || 0) + chunkSize;
        await this.state.storage.put("status", status);
      }

      return jsonOk({
        status: "done",
        partNumber,
        chunkSize,
        cpuTime: performance.now() - cpuStart,
      });
    } catch (e) {
      return jsonOk({ status: "failed", error: e.message });
    }
  }

  async doFinish() {
    const job = await this.state.storage.get("job");
    if (!job) return jsonError("No active job", 404);

    const partEntries = await this.state.storage.list({ prefix: "part_" });
    const parts = Array.from(partEntries.values()).sort(
      (a, b) => a.partNumber - b.partNumber,
    );
    if (!parts.length) return jsonError("No parts uploaded");

    const mp = this.env.WEBDAV_STORAGE.resumeMultipartUpload(
      job.filename,
      job.uploadId,
    );
    await mp.complete(parts);

    await this.state.storage.put("status", {
      mode: "parallel",
      status: "completed",
      filename: job.filename,
      totalSize: job.totalSize,
      totalParts: job.totalParts,
      completedParts: job.totalParts,
      finished: Date.now(),
    });
    const delKeys = ["job", ...Array.from(partEntries.keys())];
    await this.state.storage.delete(delKeys);

    return jsonOk({ status: "completed", filename: job.filename });
  }

  async doStatus() {
    const status = await this.state.storage.get("status");
    return jsonOk(status || { status: "idle" });
  }

  async doAbort() {
    await this.state.storage.put("aborted", true);
    const job = await this.state.storage.get("job");
    if (job) {
      try {
        this.env.WEBDAV_STORAGE.resumeMultipartUpload(
          job.filename,
          job.uploadId,
        ).abort();
      } catch {}
    }
    await this.state.storage.put("status", { status: "aborted" });
    await this.state.storage.delete("job");
    return jsonOk({ status: "aborted" });
  }

  async singleStream(sourceUrl, filename, contentType) {
    try {
      const res = await fetch(sourceUrl);
      const body = await res.arrayBuffer();
      await this.env.WEBDAV_STORAGE.put(filename, body, {
        httpMetadata: { contentType },
        customMetadata: { source: sourceUrl, timestamp: Date.now().toString() },
      });
      await this.state.storage.put("status", {
        mode: "single",
        status: "completed",
        filename,
        finished: Date.now(),
      });
    } catch (e) {
      await this.state.storage.put("status", {
        mode: "single",
        status: "failed",
        filename,
        error: e.message,
      });
    }
  }
}
