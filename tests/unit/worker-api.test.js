import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/_worker.js";
import { createMockEnv, authedRequest } from "./mockStorage.js";

function api(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  return worker.fetch(
    authedRequest(env, `https://example.com${path}`, { ...init, headers }),
    env,
  );
}

test("PUT /api/upload then GET /get/:name round-trips content", async () => {
  const env = createMockEnv();
  const put = await api(env, "/api/upload?filename=/report.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "quarterly numbers",
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).status, "uploaded");

  const get = await worker.fetch(
    authedRequest(env, "https://example.com/get/report.txt"),
    env,
  );
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "quarterly numbers");
  assert.match(get.headers.get("Content-Disposition") || "", /attachment/);
});

test("GET /api/files lists uploaded files under the requested prefix", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/a.txt", { method: "PUT", body: "a" });
  await api(env, "/api/upload?filename=/folder/b.txt", {
    method: "PUT",
    body: "b",
  });

  const res = await api(env, "/api/files?prefix=/&delimiter=/");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.files.some((f) => f.key === "/a.txt"));
  assert.ok(data.folders.includes("/folder/"));
});

test("GET /api/files/info returns size and metadata for an uploaded file", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/info.txt", {
    method: "PUT",
    body: "12345",
  });
  const res = await api(env, "/api/files/info?key=/info.txt");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.size, 5);
});

test("POST /api/files/rename moves the file and its _meta sidecar", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/old.txt", {
    method: "PUT",
    body: "content",
  });

  const rename = await api(env, "/api/files/rename", {
    method: "POST",
    body: JSON.stringify({ oldName: "/old.txt", newName: "/new.txt" }),
  });
  assert.equal(rename.status, 200);

  const renamed = await worker.fetch(
    authedRequest(env, "https://example.com/get/new.txt"),
    env,
  );
  assert.equal(renamed.status, 200);
  assert.equal(await renamed.text(), "content");

  const stale = await worker.fetch(
    authedRequest(env, "https://example.com/get/old.txt"),
    env,
  );
  assert.equal(stale.status, 404);
});

test("POST /api/files/move relocates the file and its _meta sidecar", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/src.txt", {
    method: "PUT",
    body: "moved content",
  });

  const move = await api(env, "/api/files/move", {
    method: "POST",
    body: JSON.stringify({ source: "/src.txt", destination: "/dest.txt" }),
  });
  assert.equal(move.status, 200);

  assert.equal(
    (
      await worker.fetch(
        authedRequest(env, "https://example.com/get/dest.txt"),
        env,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await worker.fetch(
        authedRequest(env, "https://example.com/get/src.txt"),
        env,
      )
    ).status,
    404,
  );
});

test("POST /api/files/copy duplicates the file, leaving the source intact", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/orig.txt", {
    method: "PUT",
    body: "copy content",
  });

  const copy = await api(env, "/api/files/copy", {
    method: "POST",
    body: JSON.stringify({ source: "/orig.txt", destination: "/copy.txt" }),
  });
  assert.equal(copy.status, 200);

  const a = await worker.fetch(
    authedRequest(env, "https://example.com/get/orig.txt"),
    env,
  );
  const b = await worker.fetch(
    authedRequest(env, "https://example.com/get/copy.txt"),
    env,
  );
  assert.equal(await a.text(), "copy content");
  assert.equal(await b.text(), "copy content");
});

test("POST /api/files/delete removes the file's content and _meta sidecar", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/gone.txt", {
    method: "PUT",
    body: "bye",
  });

  const del = await api(env, "/api/files/delete", {
    method: "POST",
    body: JSON.stringify({ keys: ["/gone.txt"] }),
  });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).deleted, 1);

  assert.equal(
    (
      await worker.fetch(
        authedRequest(env, "https://example.com/get/gone.txt"),
        env,
      )
    ).status,
    404,
  );
  assert.equal(
    await env.WEBDAV_STORAGE.get("/gone.txt_meta"),
    null,
    "the _meta sidecar must be cleaned up too",
  );
});

test("POST /api/files/mkdir creates an empty-dir marker", async () => {
  const env = createMockEnv();
  const res = await api(env, "/api/files/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: "/newdir" }),
  });
  assert.equal(res.status, 200);
  const marker = await env.WEBDAV_STORAGE.get("/newdir/.emptydir");
  assert.ok(marker, "mkdir should write an .emptydir marker under the folder");
});

test("unknown API route returns 404", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    authedRequest(env, "https://example.com/api/does-not-exist"),
    env,
  );
  assert.equal(res.status, 404);
});

test("API key auth: requests are rejected without the correct key when APIKEYSECRET is set", async () => {
  const env = createMockEnv({ APIKEYSECRET: "s3cret" });
  const denied = await worker.fetch(
    new Request("https://example.com/api/files"),
    env,
  );
  assert.equal(denied.status, 401);

  const allowed = await worker.fetch(
    new Request("https://example.com/api/files?key=s3cret"),
    env,
  );
  assert.equal(allowed.status, 200);
});
