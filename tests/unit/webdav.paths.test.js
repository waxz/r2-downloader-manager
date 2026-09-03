import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeStoragePath,
  normalizeStorageKey,
  joinStoragePath,
  getParentPath,
  ensureR2CompatibleStorage,
  fetch_webdav,
} from "../../src/webdav.js";

// Regression test: src/_worker.js does
//   import { normalizeStoragePath, normalizeStorageKey, joinStoragePath,
//            ensureR2CompatibleStorage, getParentPath } from "./webdav.js";
// webdav.js used to only `export async function fetch_webdav`, so this
// import failed to resolve and the whole worker crashed at module load for
// every single request (API and WebDAV alike). Guard against regressing
// on any of those five names.
test("webdav.js exports everything _worker.js imports from it", () => {
  for (const name of [
    "fetch_webdav",
    "normalizeStoragePath",
    "normalizeStorageKey",
    "joinStoragePath",
    "ensureR2CompatibleStorage",
    "getParentPath",
  ]) {
    assert.equal(
      typeof {
        fetch_webdav,
        normalizeStoragePath,
        normalizeStorageKey,
        joinStoragePath,
        ensureR2CompatibleStorage,
        getParentPath,
      }[name],
      "function",
      `missing export: ${name}`,
    );
  }
});

test("normalizeStoragePath adds a leading slash", () => {
  assert.equal(normalizeStoragePath("foo.txt"), "/foo.txt");
});

test("normalizeStoragePath collapses duplicate slashes", () => {
  assert.equal(normalizeStoragePath("/a//b///c.txt"), "/a/b/c.txt");
});

test("normalizeStoragePath strips a trailing slash except at the root", () => {
  assert.equal(normalizeStoragePath("/folder/"), "/folder");
  assert.equal(normalizeStoragePath("/"), "/");
});

test("normalizeStoragePath treats empty/missing input as root", () => {
  assert.equal(normalizeStoragePath(""), "/");
  assert.equal(normalizeStoragePath(undefined), "/");
});

test("normalizeStorageKey agrees with normalizeStoragePath (same key convention)", () => {
  // Both webdav.js's own PUT handler and _worker.js's list-prefix logic
  // store/read R2 keys with a leading slash, so these must not diverge.
  for (const input of ["a/b/", "/a/b", "//weird//path", ""]) {
    assert.equal(normalizeStorageKey(input), normalizeStoragePath(input));
  }
});

test("joinStoragePath avoids double slashes", () => {
  assert.equal(joinStoragePath("/a/", "/b.txt"), "/a/b.txt");
  assert.equal(joinStoragePath("/a", "b.txt"), "/a/b.txt");
  assert.equal(joinStoragePath("", "b.txt"), "/b.txt");
});

test("getParentPath", () => {
  assert.equal(getParentPath("/a/b/c.txt"), "/a/b");
  assert.equal(getParentPath("/a.txt"), "/");
  assert.equal(getParentPath("/"), null);
});

test("ensureR2CompatibleStorage wraps env.WEBDAV_STORAGE exactly once", () => {
  const calls = [];
  const rawBucket = {
    get: async (k) => {
      calls.push(k);
      return null;
    },
  };
  const env = { WEBDAV_STORAGE: rawBucket };
  ensureR2CompatibleStorage(env);
  const wrapped = env.WEBDAV_STORAGE;
  assert.equal(wrapped.__webdavCompat, true);
  ensureR2CompatibleStorage(env);
  assert.equal(
    env.WEBDAV_STORAGE,
    wrapped,
    "should not re-wrap an already-compatible storage",
  );
});

test("fetch_webdav is callable end to end without throwing (smoke test for the import fix)", async () => {
  const { createMockEnv } = await import("./mockStorage.js");
  const env = createMockEnv();
  const res = await fetch_webdav(new Request("https://example.com/"), env);
  assert.ok(res instanceof Response);
});
