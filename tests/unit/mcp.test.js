// Tests for the MCP (Model Context Protocol) server at POST /mcp: a
// JSON-RPC endpoint exposing this app's R2 storage as tools (list/read/
// write/delete/move/copy) for an MCP client. Since every tool is a thin
// wrapper around the same helpers the REST routes use, these tests focus on
// the MCP-specific plumbing (JSON-RPC framing, auth, tool dispatch, error
// shape) rather than re-proving storage behavior already covered elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/_worker.js";
import { createMockEnv } from "./mockStorage.js";

function mcpRequest(env, body, headers = {}) {
  const h = new Headers(headers);
  if (!h.has("Content-Type")) h.set("Content-Type", "application/json");
  if (!h.has("x-api-key")) h.set("x-api-key", env.AUTH_KEY || env.APIKEYSECRET);
  return worker.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
    }),
    env,
  );
}

// Runs a tools/call and returns the parsed JSON the tool handler embedded
// in its text content, plus whether the call was reported as an error.
async function callTool(env, name, args) {
  const res = await mcpRequest(env, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, 1);
  const result = body.result;
  const isError = !!result.isError;
  const text = result.content?.[0]?.text;
  return {
    isError,
    text,
    // Only successful calls serialize their result as JSON text; an error
    // result's text is a plain human-readable message (see callTool in
    // mcp.js), so parsing it as JSON would fail.
    data: text && !isError ? JSON.parse(text) : undefined,
  };
}

test("initialize returns protocol version and server info", async () => {
  const env = createMockEnv();
  const res = await mcpRequest(env, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.result.protocolVersion, "2024-11-05");
  assert.equal(body.result.serverInfo.name, "r2-file-manager");
  assert.deepEqual(body.result.capabilities, { tools: {} });
});

test("tools/list returns every file-system tool with a name and schema", async () => {
  const env = createMockEnv();
  const res = await mcpRequest(env, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const body = await res.json();
  const names = body.result.tools.map((t) => t.name);
  assert.deepEqual(
    names,
    [
      "list_directory",
      "list_all_folders",
      "read_file",
      "write_file",
      "create_directory",
      "delete_file",
      "delete_directory",
      "move_file",
      "copy_file",
      "get_file_info",
      "fetch_url",
      "save_url_to_storage",
      "list_fetch_cache",
      "save_note",
      "append_note",
      "list_notes",
    ],
  );
  for (const t of body.result.tools) {
    assert.ok(t.description, `${t.name} must have a description`);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("a request without a valid API key is rejected before any JSON-RPC handling", async () => {
  const env = createMockEnv();
  const noKey = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    }),
    env,
  );
  assert.equal(noKey.status, 401);

  const wrongKey = await mcpRequest(env, { jsonrpc: "2.0", id: 1, method: "initialize" }, {
    "x-api-key": "not-the-key",
  });
  assert.equal(wrongKey.status, 401);
});

test("OPTIONS preflight returns 204 with CORS headers and no body", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "OPTIONS",
      headers: {
        "Origin": "https://claude.ai",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type, x-api-key",
      },
    }),
    env,
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.ok(res.headers.get("access-control-allow-methods").includes("POST"));
  assert.ok(res.headers.get("access-control-allow-headers").includes("x-api-key"));
  assert.equal(await res.text(), "");
});

test("POST responses carry CORS headers", async () => {
  const env = createMockEnv();
  const res = await mcpRequest(env, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("401 Unauthorized response also carries CORS headers", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("non-POST/OPTIONS requests are rejected", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/mcp?key=" + env.APIKEYSECRET, { method: "GET" }),
    env,
  );
  assert.equal(res.status, 405);
});

test("write_file then read_file round-trips UTF-8 text content", async () => {
  const env = createMockEnv();
  const write = await callTool(env, "write_file", { path: "/notes.txt", content: "hello mcp" });
  assert.equal(write.isError, false);
  assert.equal(write.data.status, "uploaded");

  const read = await callTool(env, "read_file", { path: "/notes.txt" });
  assert.equal(read.isError, false);
  assert.equal(read.data.encoding, "utf8");
  assert.equal(read.data.content, "hello mcp");
});

test("write_file/read_file round-trip base64 content for binary data", async () => {
  const env = createMockEnv();
  const bytes = Uint8Array.from([0, 1, 2, 255, 254, 253, 128]);
  const b64 = Buffer.from(bytes).toString("base64");

  const write = await callTool(env, "write_file", {
    path: "/blob.bin",
    content: b64,
    encoding: "base64",
  });
  assert.equal(write.isError, false);

  const read = await callTool(env, "read_file", { path: "/blob.bin" });
  assert.equal(read.isError, false);
  assert.equal(read.data.encoding, "base64");
  assert.deepEqual(Array.from(Buffer.from(read.data.content, "base64")), Array.from(bytes));
});

test("list_directory reflects a written file and list_all_folders reflects a nested one", async () => {
  const env = createMockEnv();
  await callTool(env, "write_file", { path: "/docs/report.txt", content: "q1" });

  const dir = await callTool(env, "list_directory", { path: "/" });
  assert.ok(dir.data.folders.includes("/docs/"));

  const folders = await callTool(env, "list_all_folders", {});
  assert.deepEqual(folders.data.folders, ["/docs"]);
});

test("create_directory makes an empty folder visible in list_directory", async () => {
  const env = createMockEnv();
  const created = await callTool(env, "create_directory", { path: "/empty" });
  assert.equal(created.isError, false);

  const dir = await callTool(env, "list_directory", { path: "/" });
  assert.ok(dir.data.folders.includes("/empty/"));
});

test("delete_file removes a file", async () => {
  const env = createMockEnv();
  await callTool(env, "write_file", { path: "/gone.txt", content: "bye" });
  const del = await callTool(env, "delete_file", { path: "/gone.txt" });
  assert.equal(del.isError, false);
  assert.equal(del.data.deleted, 1);

  const read = await callTool(env, "read_file", { path: "/gone.txt" });
  assert.equal(read.isError, true);
});

test("delete_directory recursively removes nested content", async () => {
  const env = createMockEnv();
  await callTool(env, "write_file", { path: "/tree/top.txt", content: "top" });
  await callTool(env, "write_file", { path: "/tree/sub/nested.txt", content: "nested" });

  const del = await callTool(env, "delete_directory", { path: "/tree" });
  assert.equal(del.isError, false);

  assert.equal(await env.WEBDAV_STORAGE.get("/tree/top.txt"), null);
  assert.equal(await env.WEBDAV_STORAGE.get("/tree/sub/nested.txt"), null);
});

test("delete_directory refuses to delete the root", async () => {
  const env = createMockEnv();
  const del = await callTool(env, "delete_directory", { path: "/" });
  assert.equal(del.isError, true);
  assert.match(del.text, /root/i);
});

test("move_file relocates a file and copy_file duplicates it", async () => {
  const env = createMockEnv();
  await callTool(env, "write_file", { path: "/a.txt", content: "aaa" });

  const moved = await callTool(env, "move_file", { source: "/a.txt", destination: "/b.txt" });
  assert.equal(moved.isError, false);
  assert.equal(await env.WEBDAV_STORAGE.get("/a.txt"), null);
  assert.ok(await env.WEBDAV_STORAGE.get("/b.txt"));

  const copied = await callTool(env, "copy_file", { source: "/b.txt", destination: "/c.txt" });
  assert.equal(copied.isError, false);
  assert.ok(await env.WEBDAV_STORAGE.get("/b.txt"), "copy must leave the source in place");
  assert.ok(await env.WEBDAV_STORAGE.get("/c.txt"));
});

test("get_file_info returns size and upload date for a file, and an error result for a missing one", async () => {
  const env = createMockEnv();
  await callTool(env, "write_file", { path: "/info.txt", content: "12345" });

  const info = await callTool(env, "get_file_info", { path: "/info.txt" });
  assert.equal(info.isError, false);
  assert.equal(info.data.size, 5);

  const missing = await callTool(env, "get_file_info", { path: "/nope.txt" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /not found/i);
});

test("an unknown tool name is reported as a tool error, not a protocol error", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "delete_everything", {});
  assert.equal(res.isError, true);
  assert.match(res.text, /Unknown tool/);
});

test("an unknown JSON-RPC method returns a protocol-level error", async () => {
  const env = createMockEnv();
  const res = await mcpRequest(env, { jsonrpc: "2.0", id: 1, method: "not/a/method" });
  const body = await res.json();
  assert.equal(body.error.code, -32601);
});

test("a notification (no id) gets no JSON-RPC response", async () => {
  const env = createMockEnv();
  const res = await mcpRequest(env, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "");
});

test("fetch_url rejects missing url with isError", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "fetch_url", {});
  assert.equal(res.isError, true);
  assert.match(res.text, /Missing url/i);
});

test("fetch_url rejects non-http(s) schemes with isError", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "fetch_url", { url: "ftp://example.com/file" });
  assert.equal(res.isError, true);
  assert.match(res.text, /http/i);
});

test("fetch_url rejects an invalid URL with isError", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "fetch_url", { url: "not a url at all" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Invalid URL/i);
});

test("save_url_to_storage rejects missing url", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "save_url_to_storage", {});
  assert.equal(res.isError, true);
  assert.match(res.text, /Missing url/i);
});

test("save_url_to_storage rejects non-http(s) scheme", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "save_url_to_storage", { url: "file:///etc/passwd" });
  assert.equal(res.isError, true);
  assert.match(res.text, /http/i);
});

test("list_fetch_cache returns empty list when nothing is cached", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "list_fetch_cache", {});
  assert.equal(res.isError, false);
  assert.equal(res.data.count, 0);
  assert.deepEqual(res.data.entries, []);
});

// --- Note tools ---

test("save_note writes a Markdown file with YAML frontmatter", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "save_note", {
    title: "MRTA Paper Analysis",
    content: "Some analysis text.",
    tags: ["robotics", "scheduling"],
    source_url: "https://arxiv.org/abs/2608.00648",
  });
  assert.equal(res.isError, false);
  assert.equal(res.data.status, "uploaded");
  assert.match(res.data.filename, /\/notes\/.+\.md$/);

  // The file content must include frontmatter and the title heading.
  const stored = await env.WEBDAV_STORAGE.get(res.data.filename);
  const text = await stored.text();
  assert.match(text, /^---/);
  assert.match(text, /title:/);
  assert.match(text, /robotics/);
  assert.match(text, /# MRTA Paper Analysis/);
  assert.match(text, /Some analysis text\./);
});

test("save_note rejects missing title", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "save_note", { content: "body" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Missing title/i);
});

test("save_note rejects missing content", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "save_note", { title: "T" });
  assert.equal(res.isError, true);
  assert.match(res.text, /Missing content/i);
});

test("append_note adds a timestamped section to an existing note", async () => {
  const env = createMockEnv();
  // Create a note first.
  const saved = await callTool(env, "save_note", {
    title: "Robot Nav",
    content: "Initial notes.",
    path: "/notes/robot-nav.md",
  });
  assert.equal(saved.isError, false);

  const appended = await callTool(env, "append_note", {
    path: "/notes/robot-nav.md",
    content: "Follow-up findings.",
    section_title: "Day 2",
  });
  assert.equal(appended.isError, false);
  assert.equal(appended.data.status, "appended");

  const stored = await env.WEBDAV_STORAGE.get("/notes/robot-nav.md");
  const text = await stored.text();
  assert.match(text, /Initial notes\./);
  assert.match(text, /Day 2/);
  assert.match(text, /Follow-up findings\./);
});

test("append_note returns error for a non-existent note", async () => {
  const env = createMockEnv();
  const res = await callTool(env, "append_note", {
    path: "/notes/ghost.md",
    content: "stuff",
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /not found/i);
});

test("list_notes returns saved notes with parsed frontmatter", async () => {
  const env = createMockEnv();
  await callTool(env, "save_note", {
    title: "Paper A",
    content: "Analysis A",
    tags: ["tag1"],
    path: "/notes/a.md",
  });
  await callTool(env, "save_note", {
    title: "Paper B",
    content: "Analysis B",
    path: "/notes/b.md",
  });

  const res = await callTool(env, "list_notes", {});
  assert.equal(res.isError, false);
  assert.equal(res.data.count, 2);
  const titles = res.data.notes.map(n => n.title);
  assert.ok(titles.includes("Paper A"));
  assert.ok(titles.includes("Paper B"));
  const a = res.data.notes.find(n => n.title === "Paper A");
  assert.deepEqual(a.tags, ["tag1"]);
});
