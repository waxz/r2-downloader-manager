// Regression tests for a hardcoded-default-credential vulnerability:
// verifyWebDAVCredentials() used to fall back to the literal string
// 'default' for both username and password whenever WEBDAV_USERNAME /
// WEBDAV_PASSWORD weren't configured. Since this is a public open-source
// repo, that fallback was a publicly-known credential pair — anyone could
// authenticate as default:default against any deployment where the
// operator forgot to set those two (undocumented) secrets. The fix fails
// closed instead: WebDAV auth must be explicitly configured, or every
// request is rejected, no bypass credential exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetch_webdav, timingSafeEqual } from "../../src/webdav.js";
import worker from "../../src/_worker.js";
import { createMockEnv, basicAuthHeader } from "./mockStorage.js";

function dav(env, path, init = {}) {
  return fetch_webdav(new Request(`https://example.com${path}`, init), env);
}

test("WebDAV auth is fully denied (fail closed) when WEBDAV_USERNAME/PASSWORD are not configured", async () => {
  const env = createMockEnv({
    WEBDAV_USERNAME: undefined,
    WEBDAV_PASSWORD: undefined,
  });

  // The old hardcoded fallback must not work as a bypass.
  const withOldDefault = await dav(env, "/hello.txt", {
    headers: { Authorization: basicAuthHeader("default", "default") },
  });
  assert.equal(withOldDefault.status, 401);

  // No credentials at all must also be denied (not silently "authenticated").
  const withNoAuth = await dav(env, "/hello.txt");
  assert.equal(withNoAuth.status, 401);

  // Any other guess must also fail — there is no valid credential at all
  // while unconfigured, not even an empty username/password.
  const withEmptyCreds = await dav(env, "/hello.txt", {
    headers: { Authorization: basicAuthHeader("", "") },
  });
  assert.equal(withEmptyCreds.status, 401);
});

test("WebDAV auth is denied (fail closed) when only one of USERNAME/PASSWORD is configured", async () => {
  const envNoPassword = createMockEnv({
    WEBDAV_USERNAME: "demo",
    WEBDAV_PASSWORD: undefined,
  });
  const res1 = await dav(envNoPassword, "/hello.txt", {
    headers: { Authorization: basicAuthHeader("demo", "default") },
  });
  assert.equal(res1.status, 401);

  const envNoUsername = createMockEnv({
    WEBDAV_USERNAME: undefined,
    WEBDAV_PASSWORD: "demo",
  });
  const res2 = await dav(envNoUsername, "/hello.txt", {
    headers: { Authorization: basicAuthHeader("default", "demo") },
  });
  assert.equal(res2.status, 401);
});

test("WebDAV auth succeeds with correctly configured credentials and rejects wrong ones", async () => {
  const env = createMockEnv({
    WEBDAV_USERNAME: "alice",
    WEBDAV_PASSWORD: "s3cret-pass",
  });

  const wrong = await dav(env, "/hello.txt", {
    headers: { Authorization: basicAuthHeader("alice", "wrong") },
  });
  assert.equal(wrong.status, 401);

  const right = await dav(env, "/hello.txt", {
    method: "PUT",
    headers: {
      Authorization: basicAuthHeader("alice", "s3cret-pass"),
      "Content-Type": "text/plain",
    },
    body: "ok",
  });
  assert.equal(right.status, 201);
});

test("timingSafeEqual: correctness for equal, unequal, different-length, and empty/undefined inputs", async () => {
  assert.equal(await timingSafeEqual("secret", "secret"), true);
  assert.equal(await timingSafeEqual("secret", "wrong!"), false);
  assert.equal(await timingSafeEqual("short", "a-much-longer-value"), false);
  assert.equal(await timingSafeEqual("", ""), true);
  assert.equal(await timingSafeEqual(undefined, undefined), true);
  assert.equal(await timingSafeEqual(undefined, "x"), false);
  assert.equal(await timingSafeEqual("x", undefined), false);
});

test("the REST API key check also uses a constant-time comparison and still accepts/rejects correctly", async () => {
  const env = createMockEnv({ APIKEYSECRET: "top-secret-key" });

  const denied = await worker.fetch(
    new Request("https://example.com/api/files"),
    env,
  );
  assert.equal(denied.status, 401);

  const deniedWrong = await worker.fetch(
    new Request("https://example.com/api/files?key=not-the-key"),
    env,
  );
  assert.equal(deniedWrong.status, 401);

  const allowed = await worker.fetch(
    new Request("https://example.com/api/files?key=top-secret-key"),
    env,
  );
  assert.equal(allowed.status, 200);
});
