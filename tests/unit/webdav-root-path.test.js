// Tests for the admin-configurable WebDAV root path: an R2 key prefix that
// WebDAV clients see as "/". Two guarantees matter here:
//   1. It actually scopes the WebDAV-exposed namespace — content outside the
//      configured root is invisible to WebDAV clients.
//   2. It always resolves to something usable: an invalid/empty/corrupted
//      value falls back to "/" rather than ever leaving WebDAV broken.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/_worker.js";
import {
  fetch_webdav,
  normalizeWebdavRoot,
  webdavPathToStorage,
  storagePathToWebdav,
} from "../../src/webdav.js";
import {
  createMockEnv,
  basicAuthHeader,
  authedRequest,
} from "./mockStorage.js";

const AUTH = basicAuthHeader("demo", "demo");
function dav(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Authorization")) headers.set("Authorization", AUTH);
  return fetch_webdav(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env,
  );
}
function api(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return worker.fetch(
    authedRequest(env, `https://example.com${path}`, { ...init, headers }),
    env,
  );
}

test("normalizeWebdavRoot: valid input is normalized, invalid input falls back to '/'", () => {
  assert.equal(normalizeWebdavRoot("/data"), "/data");
  assert.equal(
    normalizeWebdavRoot("data"),
    "/data",
    "missing leading slash gets one added",
  );
  assert.equal(
    normalizeWebdavRoot("/data/"),
    "/data",
    "trailing slash stripped",
  );
  assert.equal(
    normalizeWebdavRoot("//data//sub//"),
    "/data/sub",
    "duplicate slashes collapsed",
  );
  assert.equal(normalizeWebdavRoot("/"), "/");
  assert.equal(normalizeWebdavRoot(""), "/");
  assert.equal(normalizeWebdavRoot("   "), "/");
  assert.equal(normalizeWebdavRoot(undefined), "/");
  assert.equal(normalizeWebdavRoot(null), "/");
  assert.equal(normalizeWebdavRoot(42), "/");
  assert.equal(
    normalizeWebdavRoot("/../etc"),
    "/",
    "path traversal is rejected, not passed through",
  );
  assert.equal(
    normalizeWebdavRoot("/data/../../etc"),
    "/",
    "traversal anywhere in the path is rejected",
  );
});

test("webdavPathToStorage / storagePathToWebdav round-trip for a custom root", () => {
  const root = "/data";
  assert.equal(webdavPathToStorage("/", root), "/data");
  assert.equal(webdavPathToStorage("/hello.txt", root), "/data/hello.txt");
  assert.equal(
    webdavPathToStorage("/sub/file.txt", root),
    "/data/sub/file.txt",
  );

  assert.equal(storagePathToWebdav("/data", root), "/");
  assert.equal(storagePathToWebdav("/data/hello.txt", root), "/hello.txt");
  assert.equal(
    storagePathToWebdav("/data/sub/file.txt", root),
    "/sub/file.txt",
  );

  // Round-trip identity.
  for (const p of ["/", "/hello.txt", "/sub/file.txt"]) {
    assert.equal(storagePathToWebdav(webdavPathToStorage(p, root), root), p);
  }
});

test("webdavPathToStorage / storagePathToWebdav are no-ops for the default root '/'", () => {
  assert.equal(webdavPathToStorage("/hello.txt", "/"), "/hello.txt");
  assert.equal(storagePathToWebdav("/hello.txt", "/"), "/hello.txt");
});

test("PUT/GET through a custom WebDAV root map to the prefixed storage key", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ webdavRootPath: "/data" }),
  });

  const put = await dav(env, "/hello.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "scoped content",
  });
  assert.equal(put.status, 201);
  assert.equal(
    put.headers.get("Content-Location"),
    "/hello.txt",
    "client sees its own root-relative path, not the storage prefix",
  );

  // The real R2 key is prefixed with the configured root.
  const stored = await env.WEBDAV_STORAGE.get("/data/hello.txt");
  assert.ok(stored, "file should be stored under the configured root prefix");
  assert.equal(await stored.text(), "scoped content");

  const get = await dav(env, "/hello.txt");
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "scoped content");
});

test("PROPFIND under a custom root shows client-relative paths and no href above the root", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ webdavRootPath: "/data" }),
  });
  await dav(env, "/hello.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "x",
  });

  const pf = await dav(env, "/", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  assert.equal(pf.status, 207);
  const xml = await pf.text();
  assert.match(
    xml,
    /<D:href>\/hello\.txt<\/D:href>/,
    "child href must be relative to the WebDAV root, not the storage key",
  );
  assert.ok(
    !xml.includes("/data/"),
    "the storage prefix must never leak into a client-facing href",
  );
});

test("directory listing HTML under a custom root has no '..' link at the client's own root", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ webdavRootPath: "/data" }),
  });
  await dav(env, "/hello.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "x",
  });

  const res = await dav(env, "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(
    !html.includes('class="dir">..<'),
    "must not offer a way to navigate above the configured WebDAV root",
  );
  assert.match(html, /href="\/hello\.txt"/);
  assert.ok(
    !html.includes("/data/"),
    "the storage prefix must never leak into the directory listing",
  );
});

test("content outside the configured root is invisible to WebDAV (isolation)", async () => {
  const env = createMockEnv();
  // Written directly to the bucket root, before/outside of the configured
  // WebDAV root — simulates content that belongs to the file manager only.
  await env.WEBDAV_STORAGE.put("/outside.txt", "not yours", {});
  await env.WEBDAV_STORAGE.put(
    "/outside.txt_meta",
    JSON.stringify({
      type: "file",
      size: 9,
      modifiedAt: new Date().toISOString(),
    }),
  );

  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ webdavRootPath: "/data" }),
  });

  const get = await dav(env, "/outside.txt");
  assert.equal(get.status, 404);

  const pf = await dav(env, "/", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  assert.ok(!(await pf.text()).includes("outside.txt"));
});

test("MOVE and COPY translate the Destination header through the configured root", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ webdavRootPath: "/data" }),
  });
  await dav(env, "/a.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "aaa",
  });

  const move = await dav(env, "/a.txt", {
    method: "MOVE",
    headers: { Destination: "https://example.com/b.txt" },
  });
  assert.equal(move.status, 204);
  assert.ok(
    await env.WEBDAV_STORAGE.get("/data/b.txt"),
    "MOVE destination must land under the storage prefix",
  );
  assert.equal(await env.WEBDAV_STORAGE.get("/data/a.txt"), null);

  const copy = await dav(env, "/b.txt", {
    method: "COPY",
    headers: { Destination: "https://example.com/c.txt" },
  });
  assert.equal(copy.status, 204);
  assert.ok(await env.WEBDAV_STORAGE.get("/data/c.txt"));
  assert.ok(
    await env.WEBDAV_STORAGE.get("/data/b.txt"),
    "COPY must leave the source in place",
  );
});

test("MKCOL under a custom root creates both interop markers under the storage prefix", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ webdavRootPath: "/data" }),
  });

  const mkcol = await dav(env, "/folder", { method: "MKCOL" });
  assert.equal(mkcol.status, 201);
  assert.ok(await env.WEBDAV_STORAGE.get("/data/folder_dir"));
  assert.ok(await env.WEBDAV_STORAGE.get("/data/folder/.emptydir"));

  const pf = await dav(env, "/folder", {
    method: "PROPFIND",
    headers: { Depth: "0" },
  });
  assert.equal(pf.status, 207);
  assert.match(await pf.text(), /<D:href>\/folder<\/D:href>/);
});

test("a malformed stored webdavRootPath (e.g. from corrupted data) falls back to '/' at request time", async () => {
  const env = createMockEnv();
  // Bypass the admin API's sanitization entirely, simulating pre-existing
  // corrupted settings data rather than a fresh malicious submission.
  await env.WEBDAV_STORAGE.put(
    ".settings/system.json",
    JSON.stringify({ webdavRootPath: "/../../etc" }),
  );

  const put = await dav(env, "/hello.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "still works",
  });
  assert.equal(put.status, 201);
  // Falls back to root "/" — the file lands at the bucket root, unprefixed.
  const stored = await env.WEBDAV_STORAGE.get("/hello.txt");
  assert.ok(stored);
  assert.equal(await stored.text(), "still works");
});

test("admin settings API normalizes webdavRootPath on save (missing leading slash, trailing slash)", async () => {
  const env = createMockEnv();
  const res = await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ webdavRootPath: "data/sub/" }),
  });
  const data = await res.json();
  assert.equal(data.webdavRootPath, "/data/sub");
});
