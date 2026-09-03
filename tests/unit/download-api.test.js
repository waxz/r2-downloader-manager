import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { DownloadManager } from "../../src/_worker.js";
import {
  createMockEnv,
  createMockDOState,
  authedRequest,
} from "./mockStorage.js";

function withMockFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// Fakes a Cloudflare DurableObjectNamespace binding backed by real
// DownloadManager instances, so tests can exercise the full
// /api/jobs/* routing in _worker.js exactly as the runtime would.
function createMockDurableObjectNamespace(env) {
  const instances = new Map();
  return {
    idFromName(name) {
      return name;
    },
    get(id) {
      if (!instances.has(id)) {
        instances.set(id, new DownloadManager(createMockDOState(), env));
      }
      return instances.get(id);
    },
  };
}

function sourceFetchMock({ totalSize, rangeSupport, content }) {
  return async (url, init = {}) => {
    const method = init.method || "GET";
    const headers =
      init.headers instanceof Headers
        ? init.headers
        : new Headers(init.headers || {});
    if (method === "HEAD") {
      const h = {
        "content-length": String(totalSize),
        "content-type": "application/octet-stream",
      };
      if (rangeSupport) h["accept-ranges"] = "bytes";
      return new Response(null, { status: 200, headers: h });
    }
    const rangeHeader = headers.get("Range");
    if (rangeHeader && rangeSupport) {
      const m = /bytes=(\d+)-(\d+)/.exec(rangeHeader);
      const start = Number(m[1]);
      const end = Number(m[2]);
      const slice = content.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${end}/${totalSize}`,
          "content-length": String(slice.byteLength),
        },
      });
    }
    return new Response(content, {
      status: 200,
      headers: { "content-length": String(totalSize) },
    });
  };
}

test("DownloadManager doInit picks single-stream mode for small files and completes it", async () => {
  const content = new TextEncoder().encode("hello single stream download");
  const env = createMockEnv();
  const state = createMockDOState();
  const dm = new DownloadManager(state, env);

  await withMockFetch(
    sourceFetchMock({
      totalSize: content.byteLength,
      rangeSupport: false,
      content,
    }),
    async () => {
      const res = await dm.fetch(
        new Request("https://do/init", {
          method: "POST",
          body: JSON.stringify({
            sourceUrl: "https://src.example/file",
            filename: "/single.bin",
            jobId: "job-1",
          }),
        }),
      );
      const body = await res.json();
      assert.equal(body.mode, "single");

      // singleStream() runs via state.waitUntil(); await it explicitly.
      await Promise.all(state.waitUntilPromises);

      const stored = await env.WEBDAV_STORAGE.get("/single.bin");
      assert.ok(stored, "file should have been written to storage");
      assert.equal(await stored.text(), "hello single stream download");

      const statusRes = await dm.fetch(new Request("https://do/status"));
      const status = await statusRes.json();
      assert.equal(status.status, "completed");
      assert.equal(status.mode, "single");
    },
  );
});

test("DownloadManager doInit picks parallel mode for large, range-capable sources", async () => {
  const totalSize = 25 * 1024 * 1024; // > 20MB CHUNK size in _worker.js
  const env = createMockEnv();
  const state = createMockDOState();
  const dm = new DownloadManager(state, env);

  await withMockFetch(
    sourceFetchMock({
      totalSize,
      rangeSupport: true,
      content: new Uint8Array(0),
    }),
    async () => {
      const res = await dm.fetch(
        new Request("https://do/init", {
          method: "POST",
          body: JSON.stringify({
            sourceUrl: "https://src.example/big",
            filename: "/big.bin",
            jobId: "job-2",
          }),
        }),
      );
      const body = await res.json();
      assert.equal(body.mode, "parallel");
      assert.equal(body.totalSize, totalSize);
      assert.equal(body.ranges.length, 2);
      assert.equal(body.ranges[0].start, 0);
      assert.equal(body.ranges[1].end, totalSize - 1);
    },
  );
});

test("DownloadManager doChunk + doFinish assembles multipart parts in order", async () => {
  const content = new TextEncoder().encode("PART-ONE-BYTES|PART-TWO-BYTES");
  const splitAt = "PART-ONE-BYTES|".length;
  const env = createMockEnv();
  const state = createMockDOState();
  const dm = new DownloadManager(state, env);

  // Seed a multipart job directly, mirroring what doInit's parallel branch
  // would have set up, so this test doesn't need a real 20MB+ payload to
  // trigger the parallel path.
  const mp = await env.WEBDAV_STORAGE.createMultipartUpload("/parts.bin", {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  await state.storage.put("job", {
    uploadId: mp.uploadId,
    filename: "/parts.bin",
    sourceUrl: "https://src.example/parts",
    totalSize: content.byteLength,
    totalParts: 2,
  });
  await state.storage.put("status", {
    mode: "parallel",
    status: "downloading",
    filename: "/parts.bin",
    totalSize: content.byteLength,
    totalParts: 2,
    completedParts: 0,
    bytesDownloaded: 0,
  });

  await withMockFetch(
    sourceFetchMock({
      totalSize: content.byteLength,
      rangeSupport: true,
      content,
    }),
    async () => {
      const chunk1 = await dm.fetch(
        new Request("https://do/chunk", {
          method: "POST",
          body: JSON.stringify({ partNumber: 1, start: 0, end: splitAt - 1 }),
        }),
      );
      assert.equal((await chunk1.json()).status, "done");

      const chunk2 = await dm.fetch(
        new Request("https://do/chunk", {
          method: "POST",
          body: JSON.stringify({
            partNumber: 2,
            start: splitAt,
            end: content.byteLength - 1,
          }),
        }),
      );
      assert.equal((await chunk2.json()).status, "done");

      const statusMid = await (
        await dm.fetch(new Request("https://do/status"))
      ).json();
      assert.equal(statusMid.completedParts, 2);

      const finish = await dm.fetch(
        new Request("https://do/finish", { method: "POST" }),
      );
      assert.equal((await finish.json()).status, "completed");

      const stored = await env.WEBDAV_STORAGE.get("/parts.bin");
      assert.equal(await stored.text(), "PART-ONE-BYTES|PART-TWO-BYTES");

      const statusFinal = await (
        await dm.fetch(new Request("https://do/status"))
      ).json();
      assert.equal(statusFinal.status, "completed");
    },
  );
});

test("DownloadManager doChunk fails cleanly when there is no active job", async () => {
  const dm = new DownloadManager(createMockDOState(), createMockEnv());
  const res = await dm.fetch(
    new Request("https://do/chunk", {
      method: "POST",
      body: JSON.stringify({ partNumber: 1, start: 0, end: 9 }),
    }),
  );
  const body = await res.json();
  assert.equal(body.status, "failed");
  assert.match(body.error, /No active job/);
});

test("DownloadManager doAbort marks the job aborted and rejects further chunks", async () => {
  const env = createMockEnv();
  const state = createMockDOState();
  const dm = new DownloadManager(state, env);
  const mp = await env.WEBDAV_STORAGE.createMultipartUpload("/aborted.bin", {});
  await state.storage.put("job", {
    uploadId: mp.uploadId,
    filename: "/aborted.bin",
    sourceUrl: "x",
    totalSize: 100,
    totalParts: 1,
  });

  const abort = await dm.fetch(
    new Request("https://do/abort", { method: "POST" }),
  );
  assert.equal((await abort.json()).status, "aborted");

  const chunk = await dm.fetch(
    new Request("https://do/chunk", {
      method: "POST",
      body: JSON.stringify({ partNumber: 1, start: 0, end: 9 }),
    }),
  );
  const chunkBody = await chunk.json();
  // doAbort() deletes the "job" storage key, so doChunk's very first check
  // (no active job) is what actually fires here rather than the later
  // aborted-flag check further down doChunk — either way the outcome that
  // matters is that no further chunk can be uploaded once aborted.
  assert.equal(chunkBody.status, "failed");
  assert.match(chunkBody.error, /No active job/);

  const status = await (
    await dm.fetch(new Request("https://do/status"))
  ).json();
  assert.equal(status.status, "aborted");
});

test("full worker: /api/jobs/init -> status routes through the DownloadManager Durable Object", async () => {
  const content = new TextEncoder().encode("routed through the real worker");
  const env = createMockEnv();
  env.DOWNLOAD_MANAGER = createMockDurableObjectNamespace(env);

  await withMockFetch(
    sourceFetchMock({
      totalSize: content.byteLength,
      rangeSupport: false,
      content,
    }),
    async () => {
      const initRes = await worker.fetch(
        authedRequest(env, "https://example.com/api/jobs/init", {
          method: "POST",
          body: JSON.stringify({
            sourceUrl: "https://src.example/f",
            filename: "/routed.bin",
          }),
        }),
        env,
      );
      const initBody = await initRes.json();
      assert.equal(initRes.status, 200);
      assert.equal(initBody.mode, "single");
      assert.ok(
        initBody.jobId,
        "init response should echo back the jobId the DO was created with",
      );

      // Give the fire-and-forget singleStream() a tick to finish. In the real
      // runtime this is tracked by ctx.waitUntil(); here we just poll status.
      for (let i = 0; i < 20; i++) {
        const statusRes = await worker.fetch(
          authedRequest(env, "https://example.com/api/jobs/status", {
            method: "POST",
            body: JSON.stringify({ jobId: initBody.jobId }),
          }),
          env,
        );
        const status = await statusRes.json();
        if (status.status === "completed") {
          assert.equal(status.filename, "/routed.bin");
          return;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.fail("job did not reach completed status in time");
    },
  );
});

test("/api/jobs/init rejects a missing sourceUrl/filename with 400", async () => {
  const env = createMockEnv();
  env.DOWNLOAD_MANAGER = createMockDurableObjectNamespace(env);
  const res = await worker.fetch(
    authedRequest(env, "https://example.com/api/jobs/init", {
      method: "POST",
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(res.status, 400);
});
