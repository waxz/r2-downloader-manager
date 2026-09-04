// ============================================================================
// MCP (Model Context Protocol) server
// ============================================================================
// Exposes this app's R2-backed file storage as MCP tools — list/read/write/
// delete/move/copy — over the Streamable HTTP transport
// (https://modelcontextprotocol.io/specification), so an MCP client (an AI
// agent, Claude Desktop, etc.) can browse and manage the same bucket the
// WebDAV and REST APIs already do. A single POST endpoint (/mcp, wired up in
// _worker.js) accepts JSON-RPC 2.0 requests and returns a JSON-RPC response
// directly — no SSE/session-id machinery, since every tool call here
// completes in one request/response with nothing to stream.
//
// The actual storage operations are NOT reimplemented here: every tool is a
// thin wrapper around the same helpers _worker.js's REST routes use
// (handleListFiles, deleteFilesAndFolders, relocateFile, ...), so behavior
// (path normalization, WebDAV directory-marker upkeep, error semantics)
// stays identical across WebDAV, REST and MCP rather than drifting apart.
import {
  ApiError,
  handleListFiles,
  handleListFolders,
  deleteFilesAndFolders,
  createDirectory,
  writeFile,
  relocateFile,
  getFileInfo,
} from "./_worker.js";
import { normalizeStoragePath, timingSafeEqual } from "./webdav.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "r2-file-manager";
const SERVER_VERSION = "1.0.0";

// ----------------------------------------------------------------------------
// Byte <-> base64 helpers (no Buffer — this runs in Workers, not Node)
// ----------------------------------------------------------------------------
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ----------------------------------------------------------------------------
// Tool definitions (JSON Schema) — returned from tools/list
// ----------------------------------------------------------------------------
const TOOLS = [
  {
    name: "list_directory",
    description:
      'List the files and subfolders directly inside a folder (one level deep). Use "/" for the root.',
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Folder path, e.g. "/" or "/photos"' },
      },
    },
  },
  {
    name: "list_all_folders",
    description: "List every folder in the bucket, at any depth, as a flat sorted array of paths.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description:
      "Read a file's content. Text files are returned as UTF-8 text; anything that isn't valid UTF-8 is returned base64-encoded instead.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: 'File path, e.g. "/notes.txt"' } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "Encoding of `content`. Defaults to utf8.",
        },
        contentType: { type: "string", description: "MIME type to store the file with." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "create_directory",
    description: "Create a folder (with an empty-folder marker so it shows up even before it has any files in it).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "delete_file",
    description: "Delete a single file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "delete_directory",
    description: "Recursively delete a folder and everything inside it, at any depth.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "move_file",
    description: "Move or rename a single file (not a folder).",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" }, destination: { type: "string" } },
      required: ["source", "destination"],
    },
  },
  {
    name: "copy_file",
    description: "Copy a single file to a new path (not a folder).",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" }, destination: { type: "string" } },
      required: ["source", "destination"],
    },
  },
  {
    name: "get_file_info",
    description: "Get the size, upload date and metadata for a file.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch any URL and return its content. Use this whenever direct outbound access to a " +
      "domain is blocked (e.g. egress-proxy restrictions in Claude's remote environment). " +
      "GET responses are cached in R2 by default (TTL: 86400 s) — subsequent calls to the " +
      "same URL return instantly from cache. Pass cache:false or cache_ttl:0 to bypass. " +
      "Text responses (HTML, JSON, XML, plain text) are returned as UTF-8; binary as base64.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch." },
        method: {
          type: "string",
          enum: ["GET", "HEAD", "POST"],
          description: "HTTP method (default: GET).",
        },
        headers: {
          type: "object",
          description: "Optional request headers as key/value pairs.",
          additionalProperties: { type: "string" },
        },
        body: { type: "string", description: "Request body (POST only)." },
        cache: {
          type: "boolean",
          description: "Use R2 cache for GET requests (default: true). Pass false to force a fresh fetch.",
        },
        cache_ttl: {
          type: "integer",
          description: "Cache lifetime in seconds (default: 86400). Pass 0 to disable caching.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "save_url_to_storage",
    description:
      "Download any URL and save the result as a file in R2 storage. " +
      "Useful for archiving arxiv PDFs, datasets, or any remote file so it can be " +
      "read later with read_file. The destination path defaults to /downloads/<filename>.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to download." },
        path: {
          type: "string",
          description: 'Storage path (e.g. "/papers/2608.00648.pdf"). Derived from URL if omitted.',
        },
        headers: {
          type: "object",
          description: "Optional request headers.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["url"],
    },
  },
  {
    name: "list_fetch_cache",
    description:
      "List all URLs currently held in the fetch cache, with their expiry time and age. " +
      "Use this to see what has already been fetched before calling fetch_url again.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ----------------------------------------------------------------------------
// Tool implementations — each is a thin wrapper around the shared storage
// helpers _worker.js's REST routes also use.
// ----------------------------------------------------------------------------
async function toolListDirectory(env, args) {
  const path = args?.path || "/";
  const url = new URL(
    `https://mcp.internal/api/files?prefix=${encodeURIComponent(path)}&delimiter=/&limit=1000`,
  );
  const res = await handleListFiles(url, env);
  const data = await res.json();
  return {
    path: normalizeStoragePath(path),
    files: (data.files || []).map((f) => ({ key: f.key, size: f.size, uploaded: f.uploaded })),
    folders: data.folders || [],
  };
}

async function toolListAllFolders(env) {
  const res = await handleListFolders(env);
  const data = await res.json();
  return { folders: data.folders || [] };
}

async function toolReadFile(env, args) {
  const key = normalizeStoragePath(args?.path || "");
  if (!key || key === "/") throw new ApiError("Missing path", 400);
  const obj = await env.WEBDAV_STORAGE.get(key);
  if (!obj) throw new ApiError("Not found", 404);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { path: key, encoding: "utf8", size: bytes.length, content: text };
  } catch {
    return { path: key, encoding: "base64", size: bytes.length, content: bytesToBase64(bytes) };
  }
}

async function toolWriteFile(env, args) {
  if (!args?.path) throw new ApiError("Missing path", 400);
  if (typeof args?.content !== "string") throw new ApiError("Missing content", 400);
  const bytes =
    args.encoding === "base64" ? base64ToBytes(args.content) : new TextEncoder().encode(args.content);
  return writeFile(env, args.path, bytes, args.contentType || "application/octet-stream");
}

async function toolCreateDirectory(env, args) {
  if (!args?.path) throw new ApiError("Missing path", 400);
  return createDirectory(env, args.path);
}

async function toolDeleteFile(env, args) {
  if (!args?.path) throw new ApiError("Missing path", 400);
  const { requested } = await deleteFilesAndFolders(env, { keys: [args.path] });
  return { deleted: requested, path: normalizeStoragePath(args.path) };
}

async function toolDeleteDirectory(env, args) {
  if (!args?.path) throw new ApiError("Missing path", 400);
  const path = normalizeStoragePath(args.path);
  if (path === "/") throw new ApiError("Refusing to delete the root folder", 400);
  const { requested } = await deleteFilesAndFolders(env, { prefixes: [args.path] });
  return { deleted: requested, path };
}

async function toolMoveFile(env, args) {
  if (!args?.source || !args?.destination) throw new ApiError("Missing source or destination", 400);
  return relocateFile(env, args.source, args.destination, { remove: true });
}

async function toolCopyFile(env, args) {
  if (!args?.source || !args?.destination) throw new ApiError("Missing source or destination", 400);
  return relocateFile(env, args.source, args.destination, { remove: false });
}

async function toolGetFileInfo(env, args) {
  return getFileInfo(env, args?.path || "");
}

// ----------------------------------------------------------------------------
// fetch_url / cache helpers
// ----------------------------------------------------------------------------
const CACHE_PREFIX = ".fetch_cache/";

function validateHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new ApiError("Invalid URL", 400); }
  if (!["https:", "http:"].includes(parsed.protocol))
    throw new ApiError("Only http/https URLs are allowed", 400);
  return parsed;
}

async function urlHash(url) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

async function readCache(env, hash) {
  const metaObj = await env.WEBDAV_STORAGE.get(`${CACHE_PREFIX}${hash}_meta`);
  if (!metaObj) return null;
  const meta = await metaObj.json();
  if (Date.now() > meta.expires) return null; // expired
  const bodyObj = await env.WEBDAV_STORAGE.get(`${CACHE_PREFIX}${hash}`);
  if (!bodyObj) return null;
  return { meta, body: await bodyObj.text() };
}

async function writeCache(env, hash, url, responseMeta, body, ttl) {
  await env.WEBDAV_STORAGE.put(`${CACHE_PREFIX}${hash}`, body);
  await env.WEBDAV_STORAGE.put(
    `${CACHE_PREFIX}${hash}_meta`,
    JSON.stringify({
      url,
      cached_at: new Date().toISOString(),
      expires: Date.now() + ttl * 1000,
      response: responseMeta,
    }),
  );
}

async function toolFetchUrl(env, args) {
  const rawUrl = args?.url;
  if (!rawUrl) throw new ApiError("Missing url", 400);
  validateHttpUrl(rawUrl);

  const method = (args?.method || "GET").toUpperCase();
  const useCache = args?.cache !== false && method === "GET";
  const cacheTtl = Number.isFinite(args?.cache_ttl) ? args.cache_ttl : 86400;

  if (useCache && cacheTtl > 0) {
    const hash = await urlHash(rawUrl);
    const hit = await readCache(env, hash);
    if (hit) {
      return { ...hit.meta.response, body: hit.body, cached: true, cached_at: hit.meta.cached_at };
    }
  }

  const reqInit = { method, redirect: "follow" };
  if (args?.headers && typeof args.headers === "object") reqInit.headers = args.headers;
  if (method === "POST" && args?.body) reqInit.body = args.body;

  const res = await fetch(rawUrl, reqInit);
  const contentType = res.headers.get("content-type") || "";
  const isText = /text|json|xml|javascript|form-urlencoded/.test(contentType);

  let body, encoding;
  if (isText) {
    body = await res.text();
    encoding = "utf8";
  } else {
    const bytes = new Uint8Array(await res.arrayBuffer());
    body = bytesToBase64(bytes);
    encoding = "base64";
  }

  const responseMeta = { url: rawUrl, status: res.status, content_type: contentType, encoding };

  if (useCache && cacheTtl > 0 && res.status >= 200 && res.status < 300) {
    const hash = await urlHash(rawUrl);
    await writeCache(env, hash, rawUrl, responseMeta, body, cacheTtl);
  }

  return { ...responseMeta, body, cached: false };
}

// Downloads a URL and writes the raw bytes into R2 storage.
async function toolSaveUrlToStorage(env, args) {
  const rawUrl = args?.url;
  if (!rawUrl) throw new ApiError("Missing url", 400);
  const parsed = validateHttpUrl(rawUrl);

  const filename = parsed.pathname.split("/").filter(Boolean).pop() || "download";
  const storagePath = args?.path || `/downloads/${filename}`;

  const reqInit = { redirect: "follow" };
  if (args?.headers && typeof args.headers === "object") reqInit.headers = args.headers;

  const res = await fetch(rawUrl, reqInit);
  if (!res.ok) throw new ApiError(`Fetch failed: HTTP ${res.status}`, 502);

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const bytes = new Uint8Array(await res.arrayBuffer());
  return writeFile(env, storagePath, bytes, contentType);
}

// Lists all entries in the fetch cache with expiry and freshness info.
async function toolListFetchCache(env) {
  const listed = await env.WEBDAV_STORAGE.list({ prefix: CACHE_PREFIX, limit: 500 });
  const now = Date.now();
  const entries = [];
  for (const obj of listed.objects || []) {
    if (!obj.key.endsWith("_meta")) continue;
    try {
      const raw = await env.WEBDAV_STORAGE.get(obj.key);
      const meta = await raw.json();
      entries.push({
        url: meta.url,
        cached_at: meta.cached_at,
        expires_at: new Date(meta.expires).toISOString(),
        ttl_remaining_s: Math.max(0, Math.round((meta.expires - now) / 1000)),
        expired: now > meta.expires,
        status: meta.response?.status,
        content_type: meta.response?.content_type,
      });
    } catch {}
  }
  entries.sort((a, b) => a.url.localeCompare(b.url));
  return { count: entries.length, entries };
}

const TOOL_HANDLERS = {
  list_directory: toolListDirectory,
  list_all_folders: toolListAllFolders,
  read_file: toolReadFile,
  write_file: toolWriteFile,
  create_directory: toolCreateDirectory,
  delete_file: toolDeleteFile,
  delete_directory: toolDeleteDirectory,
  move_file: toolMoveFile,
  copy_file: toolCopyFile,
  get_file_info: toolGetFileInfo,
  fetch_url: toolFetchUrl,
  save_url_to_storage: toolSaveUrlToStorage,
  list_fetch_cache: toolListFetchCache,
};

// Tool-execution failures (bad args, "not found", "already exists", ...) are
// reported *inside* a normal tools/call result as isError:true, per the MCP
// spec — not as a JSON-RPC protocol-level error — so an MCP client/LLM sees
// the failure as part of the conversation instead of a broken connection.
async function callTool(env, name, args) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await handler(env, args || {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
}

// ----------------------------------------------------------------------------
// JSON-RPC 2.0 plumbing
// ----------------------------------------------------------------------------
function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Returns null for a notification (no "id"): JSON-RPC notifications get no
// response at all, per spec.
async function handleJsonRpcMessage(env, msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return isNotification
        ? null
        : jsonRpcResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });

    // Client lifecycle notifications: nothing to do, nothing to reply with.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : jsonRpcResult(id, {});

    case "tools/list":
      return isNotification ? null : jsonRpcResult(id, { tools: TOOLS });

    case "tools/call": {
      const result = await callTool(env, params?.name, params?.arguments);
      return isNotification ? null : jsonRpcResult(id, result);
    }

    default:
      return isNotification ? null : jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function fetch_mcp(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  // Same API key gate /api/* uses (see fetch_api in _worker.js): fails
  // closed if no key is configured, rather than leaving file access open.
  const authKey = env.AUTH_KEY || env.APIKEYSECRET;
  const url = new URL(request.url);
  const providedKey = request.headers.get("x-api-key") || url.searchParams.get("key");
  if (!authKey || !providedKey || !(await timingSafeEqual(providedKey, authKey))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(jsonRpcError(null, -32700, "Parse error"), { status: 400 });
  }

  const messages = Array.isArray(body) ? body : [body];
  const responses = [];
  for (const msg of messages) {
    const res = await handleJsonRpcMessage(env, msg);
    if (res) responses.push(res);
  }

  // Every message in the batch was a notification: nothing to send back.
  if (!responses.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
