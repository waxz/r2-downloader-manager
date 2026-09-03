import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/_worker.js";
import { fetch_webdav, DEFAULT_SETTINGS } from "../../src/webdav.js";
import { createMockEnv, basicAuthHeader } from "./mockStorage.js";

function api(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return worker.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env,
  );
}

test("GET /api/system/info works without an API key and reports the app version", async () => {
  const env = createMockEnv({ APIKEYSECRET: "s3cret" });
  const res = await worker.fetch(
    new Request("https://example.com/api/system/info"),
    env,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof data.repoOwner, "string");
  assert.equal(typeof data.repoName, "string");
  assert.equal(data.maintenanceMode, false);
});

test("GET /api/admin/settings returns defaults when nothing has been saved yet", async () => {
  const env = createMockEnv();
  const res = await api(env, "/api/admin/settings");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, DEFAULT_SETTINGS);
});

test("POST /api/admin/settings persists a patch and GET reflects it afterwards", async () => {
  const env = createMockEnv();
  const post = await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({
      siteTitle: "Acme Drive",
      maxUploadSizeMB: 250,
      rateLimitPerMinute: 120,
    }),
  });
  assert.equal(post.status, 200);
  const posted = await post.json();
  assert.equal(posted.siteTitle, "Acme Drive");
  assert.equal(posted.maxUploadSizeMB, 250);
  assert.equal(posted.rateLimitPerMinute, 120);

  const get = await api(env, "/api/admin/settings");
  const data = await get.json();
  assert.equal(data.siteTitle, "Acme Drive");
  assert.equal(data.maxUploadSizeMB, 250);
});

test("POST /api/admin/settings ignores unknown fields and clamps out-of-range numbers", async () => {
  const env = createMockEnv();
  const res = await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({
      maxUploadSizeMB: 999999,
      rateLimitPerMinute: -5,
      evilField: "<script>",
    }),
  });
  const data = await res.json();
  assert.equal(
    data.maxUploadSizeMB,
    5000,
    "must be clamped to the documented max",
  );
  assert.equal(
    data.rateLimitPerMinute,
    1,
    "must be clamped to the documented min",
  );
  assert.equal(data.evilField, undefined);
});

test("POST /api/admin/settings/reset restores defaults", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ siteTitle: "Changed" }),
  });
  const reset = await api(env, "/api/admin/settings/reset", { method: "POST" });
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), DEFAULT_SETTINGS);
});

test("admin settings routes require the API key when one is configured", async () => {
  const env = createMockEnv({ APIKEYSECRET: "s3cret" });
  const res = await worker.fetch(
    new Request("https://example.com/api/admin/settings"),
    env,
  );
  assert.equal(res.status, 401);
});

test("maintenance mode blocks other management API routes but not the settings routes themselves", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ maintenanceMode: true }),
  });

  const filesRes = await api(env, "/api/files");
  assert.equal(filesRes.status, 503);

  // The admin must still be able to read/flip settings to exit maintenance mode.
  const settingsRes = await api(env, "/api/admin/settings");
  assert.equal(settingsRes.status, 200);

  const off = await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ maintenanceMode: false }),
  });
  assert.equal(off.status, 200);

  const filesResAfter = await api(env, "/api/files");
  assert.equal(filesResAfter.status, 200);
});

test("maintenance mode blocks WebDAV access with 503", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ maintenanceMode: true }),
  });

  const res = await fetch_webdav(
    new Request("https://example.com/hello.txt", {
      headers: { Authorization: basicAuthHeader("demo", "demo") },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("webdavEnabled=false blocks WebDAV access even outside maintenance mode", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ webdavEnabled: false }),
  });

  const res = await fetch_webdav(
    new Request("https://example.com/hello.txt", {
      headers: { Authorization: basicAuthHeader("demo", "demo") },
    }),
    env,
  );
  assert.equal(res.status, 503);
});

test("public share links are blocked when allowPublicShares is false", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/shared.txt", {
    method: "PUT",
    body: "shared content",
  });
  const create = await api(env, "/api/shares/create", {
    method: "POST",
    body: JSON.stringify({ filename: "/shared.txt", hours: 24 }),
  });
  const share = await create.json();

  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ allowPublicShares: false }),
  });

  const res = await worker.fetch(
    new Request(`https://example.com${share.url}`),
    env,
  );
  assert.equal(res.status, 403);
});

test("WebDAV PUT enforces the configured maxUploadSizeMB", async () => {
  const env = createMockEnv();
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ maxUploadSizeMB: 1 }),
  });

  const res = await fetch_webdav(
    new Request("https://example.com/big.bin", {
      method: "PUT",
      headers: {
        Authorization: basicAuthHeader("demo", "demo"),
        "Content-Type": "application/octet-stream",
        "Content-Length": String(2 * 1024 * 1024),
      },
      body: new Uint8Array(2 * 1024 * 1024),
    }),
    env,
  );
  assert.equal(res.status, 413);
});

test("the saved system-settings key never leaks into the /api/files listing", async () => {
  const env = createMockEnv();
  // Save settings on an otherwise-empty bucket: this is the one case where
  // /api/files' fallback listing (no prefix filter at all) kicks in, since
  // the primary "/" -prefixed query comes back completely empty.
  await api(env, "/api/admin/settings", {
    method: "POST",
    body: JSON.stringify({ siteTitle: "Leak Check" }),
  });

  const res = await api(
    env,
    "/api/files?" + new URLSearchParams({ prefix: "/", delimiter: "/" }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.files, []);
  assert.deepEqual(data.folders, []);
});

test("share tokens never leak into the /api/files listing", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/shared.txt", {
    method: "PUT",
    body: "shared content",
  });
  await api(env, "/api/shares/create", {
    method: "POST",
    body: JSON.stringify({ filename: "/shared.txt", hours: 24 }),
  });

  const res = await api(
    env,
    "/api/files?" + new URLSearchParams({ prefix: "/", delimiter: "/" }),
  );
  const data = await res.json();
  assert.deepEqual(
    data.files.map((f) => f.key),
    ["/shared.txt"],
  );
  assert.deepEqual(data.folders, []);
});
