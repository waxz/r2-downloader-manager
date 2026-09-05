import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/_worker.js";
import { createMockEnv, authedRequest, basicAuthHeader } from "./mockStorage.js";

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

test("GET /api/folders returns every folder in the bucket, at any depth", async () => {
  const env = createMockEnv();
  // A file nested several levels deep, with no explicit mkdir along the
  // way — the endpoint must still surface every ancestor folder, since
  // that's the whole point of the destination-folder dropdown it feeds.
  await api(env, "/api/upload?filename=/docs/reports/q1.txt", {
    method: "PUT",
    body: "q1",
  });
  // An empty folder created via mkdir (no files inside it at all).
  await api(env, "/api/files/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: "/empty" }),
  });

  const res = await api(env, "/api/folders");
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(
    data.folders,
    ["/docs", "/docs/reports", "/empty"],
    "every ancestor folder must be included, sorted, with no duplicates",
  );
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

test("POST /api/files/delete with a prefix removes a folder's contents at every depth", async () => {
  const env = createMockEnv();
  await api(env, "/api/upload?filename=/docs/top.txt", {
    method: "PUT",
    body: "top",
  });
  await api(env, "/api/upload?filename=/docs/sub/nested.txt", {
    method: "PUT",
    body: "nested",
  });
  await api(env, "/api/files/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: "/docs" }),
  });
  await api(env, "/api/files/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: "/docs/sub" }),
  });

  // Deleting via the one-level listing the frontend has (only "/docs/top.txt"
  // and the "/docs/sub/" subfolder, not what's inside it) used to leave
  // "/docs/sub/nested.txt" behind, so the "deleted" folder would reappear on
  // the next listing. The server must walk the whole subtree itself.
  const del = await api(env, "/api/files/delete", {
    method: "POST",
    body: JSON.stringify({ prefix: "/docs/" }),
  });
  assert.equal(del.status, 200);

  assert.equal(await env.WEBDAV_STORAGE.get("/docs/top.txt"), null);
  assert.equal(await env.WEBDAV_STORAGE.get("/docs/sub/nested.txt"), null);
  assert.equal(await env.WEBDAV_STORAGE.get("/docs/sub/nested.txt_meta"), null);
  assert.equal(await env.WEBDAV_STORAGE.get("/docs/.emptydir"), null);
  assert.equal(await env.WEBDAV_STORAGE.get("/docs/sub/.emptydir"), null);
  assert.equal(await env.WEBDAV_STORAGE.get("/docs_dir"), null);
  assert.equal(await env.WEBDAV_STORAGE.get("/docs/sub_dir"), null);

  const listing = await api(env, "/api/files?prefix=/&delimiter=/");
  const data = await listing.json();
  assert.ok(
    !(data.folders || []).includes("/docs/"),
    "the deleted folder must not reappear in a fresh listing",
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

test("GET / from a browser serves the admin frontend", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0" },
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /mock frontend/);
});

test("GET / from a WebDAV client (non-browser User-Agent, no credentials yet) gets a Basic-Auth challenge, not the frontend", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/", {
      headers: { "User-Agent": "Microsoft-WebDAV-MiniRedir/10.0.19045" },
    }),
    env,
  );
  // Serving the frontend's HTML here instead of a proper 401 challenge is
  // exactly what stopped WebDAV clients from being able to mount "/": they
  // never learn the server wants Basic Auth, and the response carries none
  // of the DAV capability headers a client checks for.
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate") || "", /Basic/);
  assert.ok(res.headers.get("DAV"), "must advertise DAV capability");
  const body = await res.text();
  assert.ok(!body.includes("mock frontend"));
});

test("GET / with WebDAV Basic Auth credentials reaches WebDAV even with a browser-like User-Agent", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/", {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Authorization: basicAuthHeader("demo", "demo"),
      },
    }),
    env,
  );
  const body = await res.text();
  assert.ok(
    !body.includes("mock frontend"),
    "a request carrying WebDAV credentials must never be routed to the frontend",
  );
});

test("HEAD / with valid WebDAV credentials returns a real WebDAV response, not the frontend", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/", {
      method: "HEAD",
      headers: {
        "User-Agent": "Microsoft-WebDAV-MiniRedir/10.0.19045",
        Authorization: basicAuthHeader("demo", "demo"),
      },
    }),
    env,
  );
  assert.equal(res.status, 200);
});

// --- CORS ---

test("OPTIONS /api preflight returns 204 with CORS headers", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/api/files", { method: "OPTIONS" }),
    env,
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.ok(res.headers.get("access-control-allow-methods").includes("POST"));
  assert.equal(await res.text(), "");
});

test("GET /api response carries CORS headers", async () => {
  const env = createMockEnv();
  const res = await api(env, "/api/files");
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("OPTIONS /mcp preflight returns 204 with CORS headers", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/mcp", { method: "OPTIONS" }),
    env,
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(await res.text(), "");
});

test("WebDAV OPTIONS response carries CORS headers alongside DAV headers", async () => {
  const env = createMockEnv();
  const res = await worker.fetch(
    new Request("https://example.com/", {
      method: "OPTIONS",
      headers: { Authorization: basicAuthHeader("demo", "demo") },
    }),
    env,
  );
  // WebDAV OPTIONS must still carry DAV capability header.
  assert.ok(res.headers.get("dav"), "DAV header must be present");
  // And CORS headers must be present too.
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.ok(res.headers.get("access-control-allow-methods").includes("PROPFIND"));
});
