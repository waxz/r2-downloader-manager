// Regression tests for a folder-visibility mismatch between the two
// directory-marker conventions this app uses on the same R2 bucket:
//   - WebDAV (src/webdav.js) recognizes a directory ONLY via a
//     "<path>_dir" marker key.
//   - The file manager REST API (src/_worker.js, handleListFiles)
//     recognizes a directory ONLY via real nested R2 keys (R2's native
//     prefix/delimiter grouping), plus a nested "<path>/.emptydir" marker
//     it writes itself so a brand new empty folder has *something* nested
//     under its prefix to group on.
// Before this fix, MKCOL only wrote the "_dir" marker and /api/files/mkdir
// only wrote ".emptydir" — so an empty folder created on one side was
// invisible on the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../../src/_worker.js";
import { fetch_webdav } from "../../src/webdav.js";
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

test("an empty folder created via the file manager (mkdir) is visible over WebDAV", async () => {
  const env = createMockEnv();
  const mk = await api(env, "/api/files/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: "/from-api" }),
  });
  assert.equal(mk.status, 200);

  // PROPFIND on root should list it as a child collection.
  const pf = await dav(env, "/", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  assert.equal(pf.status, 207);
  const xml = await pf.text();
  assert.match(xml, /from-api/);

  // PROPFIND directly on the folder should resolve it as a collection, not 404.
  const pfSelf = await dav(env, "/from-api", {
    method: "PROPFIND",
    headers: { Depth: "0" },
  });
  assert.equal(pfSelf.status, 207);
  assert.match(await pfSelf.text(), /<D:collection\/>/);
});

test("an empty folder created via WebDAV (MKCOL) is visible in the file manager listing", async () => {
  const env = createMockEnv();
  const mkcol = await dav(env, "/from-webdav", { method: "MKCOL" });
  assert.equal(mkcol.status, 201);

  const res = await api(
    env,
    "/api/files?" + new URLSearchParams({ prefix: "/", delimiter: "/" }),
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.folders, ["/from-webdav/"]);
  // The interop marker itself must not leak as a visible file.
  assert.ok(!data.files.some((f) => f.key.includes(".emptydir")));
});

test("nested empty folders created via WebDAV are visible in the file manager, and vice versa", async () => {
  const env = createMockEnv();
  await dav(env, "/parent", { method: "MKCOL" });
  await dav(env, "/parent/child-webdav", { method: "MKCOL" });
  await api(env, "/api/files/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: "/parent/child-api" }),
  });

  const res = await api(
    env,
    "/api/files?" + new URLSearchParams({ prefix: "/parent/", delimiter: "/" }),
  );
  const data = await res.json();
  assert.deepEqual(data.folders.sort(), [
    "/parent/child-api/",
    "/parent/child-webdav/",
  ]);

  const pf = await dav(env, "/parent", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  const xml = await pf.text();
  assert.match(xml, /child-webdav/);
  assert.match(xml, /child-api/);
});

test("backward compat: a folder that only has the old .emptydir marker (no _dir) still resolves over WebDAV", async () => {
  const env = createMockEnv();
  // Simulate data created by the pre-fix version of /api/files/mkdir, which
  // wrote only the nested ".emptydir" marker and no "_dir" marker at all.
  await env.WEBDAV_STORAGE.put("/legacy-folder/.emptydir", new Uint8Array(0), {
    customMetadata: { type: "folder" },
  });

  const pfSelf = await dav(env, "/legacy-folder", {
    method: "PROPFIND",
    headers: { Depth: "0" },
  });
  assert.equal(pfSelf.status, 207);
  assert.match(await pfSelf.text(), /<D:collection\/>/);

  const pfParent = await dav(env, "/", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  assert.match(await pfParent.text(), /legacy-folder/);
});

test("deleting a folder from the file manager also removes the WebDAV _dir marker (no ghost directory)", async () => {
  const env = createMockEnv();
  await api(env, "/api/files/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: "/temp-folder" }),
  });
  // Sanity: visible over WebDAV before deletion.
  assert.equal(
    (
      await dav(env, "/temp-folder", {
        method: "PROPFIND",
        headers: { Depth: "0" },
      })
    ).status,
    207,
  );

  const del = await api(env, "/api/files/delete", {
    method: "POST",
    body: JSON.stringify({
      keys: ["/temp-folder/.emptydir", "/temp-folder_dir"],
    }),
  });
  assert.equal(del.status, 200);

  // PROPFIND directly on the now-deleted path isn't a reliable check here:
  // handlePropfind deliberately synthesizes a fake directory response (207)
  // for any extensionless path with no resource info, to stay lenient with
  // WebDAV clients that probe plausible-looking directory paths. What must
  // actually reflect reality is the parent's own child listing.
  const pfParent = await dav(env, "/", {
    method: "PROPFIND",
    headers: { Depth: "1" },
  });
  assert.ok(!(await pfParent.text()).includes("temp-folder"));
});

test("deleting a folder over WebDAV also removes the .emptydir marker (no ghost folder in the file manager)", async () => {
  const env = createMockEnv();
  await dav(env, "/temp-webdav-folder", { method: "MKCOL" });
  assert.equal(
    (
      await api(
        env,
        "/api/files?" + new URLSearchParams({ prefix: "/", delimiter: "/" }),
      ).then((r) => r.json())
    ).folders.length,
    1,
  );

  const del = await dav(env, "/temp-webdav-folder", { method: "DELETE" });
  assert.equal(del.status, 204);

  const data = await api(
    env,
    "/api/files?" + new URLSearchParams({ prefix: "/", delimiter: "/" }),
  ).then((r) => r.json());
  assert.deepEqual(data.folders, []);
});

test("a WebDAV MOVE of a directory carries its .emptydir interop marker along", async () => {
  const env = createMockEnv();
  await dav(env, "/movable", { method: "MKCOL" });
  const move = await dav(env, "/movable", {
    method: "MOVE",
    headers: { Destination: "https://example.com/moved" },
  });
  assert.equal(move.status, 204);

  const data = await api(
    env,
    "/api/files?" + new URLSearchParams({ prefix: "/", delimiter: "/" }),
  ).then((r) => r.json());
  assert.deepEqual(data.folders, ["/moved/"]);
});
