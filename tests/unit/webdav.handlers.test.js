import { test } from "node:test";
import assert from "node:assert/strict";
import { fetch_webdav } from "../../src/webdav.js";
import worker from "../../src/_worker.js";
import { createMockEnv, basicAuthHeader } from "./mockStorage.js";

const AUTH = basicAuthHeader("demo", "demo");
function dav(env, path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (!headers.has("Authorization")) headers.set("Authorization", AUTH);
  return fetch_webdav(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env,
  );
}

// A raw '<', '>' etc. placed directly in a Request's URL string gets
// percent-encoded by the URL parser before the handler ever sees it, so it
// can't be used to reproduce a stored-XSS bug that way. Go through
// /api/upload instead: it reads the filename via url.searchParams.get(),
// which transparently decodes back to the exact raw string, then writes
// that raw string straight into the R2 key — matching how a real client
// supplying a crafted filename in a form/query param would behave.
async function uploadViaApi(env, name, content) {
  const url = new URL("https://example.com/api/upload");
  url.searchParams.set("filename", name);
  const res = await worker.fetch(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: content,
    }),
    env,
  );
  assert.equal(
    res.status,
    200,
    `upload of ${JSON.stringify(name)} should succeed`,
  );
}

test("WebDAV requests without credentials are rejected with 401 + WWW-Authenticate", async () => {
  const env = createMockEnv();
  const res = await fetch_webdav(
    new Request("https://example.com/hello.txt"),
    env,
  );
  assert.equal(res.status, 401);
  assert.match(res.headers.get("WWW-Authenticate") || "", /Basic/);
});

test("WebDAV requests with wrong Basic Auth credentials are rejected", async () => {
  const env = createMockEnv();
  const res = await fetch_webdav(
    new Request("https://example.com/hello.txt", {
      headers: { Authorization: basicAuthHeader("demo", "wrong") },
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("PUT then GET round-trips file content", async () => {
  const env = createMockEnv();
  const put = await dav(env, "/hello.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "hello world",
  });
  assert.equal(put.status, 201);

  const get = await dav(env, "/hello.txt");
  assert.equal(get.status, 200);
  assert.equal(await get.text(), "hello world");
});

test("GET on a missing file returns 404", async () => {
  const env = createMockEnv();
  const res = await dav(env, "/nope.txt");
  assert.equal(res.status, 404);
});

test("PROPFIND returns 207 Multi-Status (not the Response default of 200)", async () => {
  const env = createMockEnv();
  await dav(env, "/hello.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "x",
  });
  const res = await dav(env, "/", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  assert.equal(res.status, 207);
  const xml = await res.text();
  assert.match(xml, /<D:multistatus/);
  assert.match(xml, /hello\.txt/);
});

test("MKCOL creates a directory and PROPFIND depth=1 lists its children", async () => {
  const env = createMockEnv();
  const mk = await dav(env, "/folder", { method: "MKCOL" });
  assert.equal(mk.status, 201);

  const put = await dav(env, "/folder/a.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "aaa",
  });
  assert.equal(put.status, 201);

  const pf = await dav(env, "/folder", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  assert.equal(pf.status, 207);
  assert.match(await pf.text(), /a\.txt/);
});

test("MOVE of a directory recursively relocates nested files (regression: used to only move the _dir marker)", async () => {
  const env = createMockEnv();
  await dav(env, "/nest", { method: "MKCOL" });
  await dav(env, "/nest/sub", { method: "MKCOL" });
  await dav(env, "/nest/a.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "aaa",
  });
  await dav(env, "/nest/sub/b.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "bbb",
  });

  const move = await dav(env, "/nest", {
    method: "MOVE",
    headers: { Destination: "https://example.com/nest-moved" },
  });
  assert.equal(move.status, 204);

  const a = await dav(env, "/nest-moved/a.txt");
  assert.equal(a.status, 200);
  assert.equal(await a.text(), "aaa");

  const b = await dav(env, "/nest-moved/sub/b.txt");
  assert.equal(b.status, 200);
  assert.equal(await b.text(), "bbb");

  // Old paths must be gone, not orphaned.
  assert.equal((await dav(env, "/nest/a.txt")).status, 404);
  assert.equal((await dav(env, "/nest/sub/b.txt")).status, 404);
});

test("COPY of a directory recursively duplicates nested files and leaves the source intact", async () => {
  const env = createMockEnv();
  await dav(env, "/cpdir", { method: "MKCOL" });
  await dav(env, "/cpdir/f.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "folder content",
  });

  const copy = await dav(env, "/cpdir", {
    method: "COPY",
    headers: { Destination: "https://example.com/cpdir-copy" },
  });
  assert.equal(copy.status, 204);

  const copied = await dav(env, "/cpdir-copy/f.txt");
  assert.equal(copied.status, 200);
  assert.equal(await copied.text(), "folder content");

  const original = await dav(env, "/cpdir/f.txt");
  assert.equal(original.status, 200);
  assert.equal(await original.text(), "folder content");
});

test("MOVE with Overwrite: F returns 412 when the destination exists, and touches neither file", async () => {
  const env = createMockEnv();
  await dav(env, "/a.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "aaa",
  });
  await dav(env, "/b.txt", {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: "bbb",
  });

  const move = await dav(env, "/a.txt", {
    method: "MOVE",
    headers: { Destination: "https://example.com/b.txt", Overwrite: "F" },
  });
  assert.equal(move.status, 412);

  assert.equal(await (await dav(env, "/a.txt")).text(), "aaa");
  assert.equal(await (await dav(env, "/b.txt")).text(), "bbb");
});

test("MOVE of a nonexistent source returns 404", async () => {
  const env = createMockEnv();
  const res = await dav(env, "/nope.txt", {
    method: "MOVE",
    headers: { Destination: "https://example.com/dest.txt" },
  });
  assert.equal(res.status, 404);
});

test("directory listing HTML escapes file names to prevent stored XSS", async () => {
  const env = createMockEnv();
  // No '/' in the name: this app encodes directory structure as '/' inside
  // a single flat R2 key, so a literal '/' in a filename would itself be
  // (mis)interpreted as a path segment rather than exercising the HTML
  // escaping this test targets.
  const evilName = '"><svg onload=alert(1)>.txt';
  await uploadViaApi(env, `/${evilName}`, "x");

  const listing = await dav(env, "/");
  assert.equal(listing.status, 200);
  const html = await listing.text();
  assert.ok(
    !html.includes("<svg onload=alert(1)>"),
    "raw <svg onload> must not appear unescaped in directory listing HTML",
  );
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
});

test("PROPFIND XML escapes file names to keep the response well-formed and XSS-safe", async () => {
  const env = createMockEnv();
  const evilName = "weird<&>name.txt";
  await uploadViaApi(env, `/${evilName}`, "x");

  const res = await dav(env, "/", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  const xml = await res.text();
  assert.ok(
    !xml.includes("<&>"),
    "raw special characters must not appear unescaped in PROPFIND XML",
  );
  assert.match(xml, /&lt;&amp;&gt;/);
});
