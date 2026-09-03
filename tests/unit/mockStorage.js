// In-memory fakes for the Cloudflare bindings the app depends on
// (an R2 bucket for WEBDAV_STORAGE, and Durable Object storage for
// DownloadManager) so the request handlers can be unit-tested with
// node:test, without spinning up wrangler/Miniflare.

async function readAllBytes(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (typeof value.getReader === "function") {
    // ReadableStream
    const reader = value.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  if (typeof value.arrayBuffer === "function") {
    // Blob-like
    return new Uint8Array(await value.arrayBuffer());
  }
  throw new Error("mockStorage: unsupported value type for put()");
}

class MockR2ObjectBody {
  constructor(key, entry) {
    this.key = key;
    this.size = entry.bytes.byteLength;
    this.uploaded = entry.uploaded;
    this.httpMetadata = entry.httpMetadata || {};
    this.customMetadata = entry.customMetadata || {};
    this.etag = entry.etag;
    this.httpEtag = `"${entry.etag}"`;
    this._bytes = entry.bytes;
  }
  // Real R2ObjectBody exposes a ReadableStream `.body`; code such as the
  // "/get/:name" download route in _worker.js does `new Response(obj.body, ...)`
  // directly, so this needs to behave like one rather than being omitted.
  get body() {
    const bytes = this._bytes;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  async arrayBuffer() {
    const b = this._bytes;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
  async text() {
    return new TextDecoder().decode(this._bytes);
  }
  async json() {
    return JSON.parse(await this.text());
  }
  writeHttpMetadata(headers) {
    if (this.httpMetadata.contentType) {
      headers.set("Content-Type", this.httpMetadata.contentType);
    }
  }
}

// Minimal stand-in for an R2Bucket binding: supports the subset of the API
// this app actually uses (get/put/delete/head/list plus multipart upload).
export class MockR2Bucket {
  constructor() {
    this.store = new Map();
    this._multipart = new Map();
    this._nextEtag = 1;
  }

  async put(key, value, options = {}) {
    const bytes = await readAllBytes(value);
    const entry = {
      bytes,
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {},
      uploaded: new Date(),
      etag: String(this._nextEtag++),
    };
    this.store.set(key, entry);
    return new MockR2ObjectBody(key, entry);
  }

  async get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return new MockR2ObjectBody(key, entry);
  }

  async head(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      key,
      size: entry.bytes.byteLength,
      uploaded: entry.uploaded,
      httpMetadata: entry.httpMetadata,
      customMetadata: entry.customMetadata,
      etag: entry.etag,
      httpEtag: `"${entry.etag}"`,
    };
  }

  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }

  async list(options = {}) {
    const { prefix = "", delimiter, cursor, limit = 1000 } = options;
    const matched = Array.from(this.store.keys())
      .filter((k) => k.startsWith(prefix))
      .sort();

    const delimitedPrefixes = new Set();
    const objectKeys = [];
    for (const key of matched) {
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx !== -1) {
          delimitedPrefixes.add(prefix + rest.slice(0, idx + delimiter.length));
          continue;
        }
      }
      objectKeys.push(key);
    }

    const start = cursor ? Number(cursor) : 0;
    const page = objectKeys.slice(start, start + limit);
    const truncated = start + limit < objectKeys.length;

    return {
      objects: page.map((key) => {
        const entry = this.store.get(key);
        return {
          key,
          size: entry.bytes.byteLength,
          uploaded: entry.uploaded,
          httpMetadata: entry.httpMetadata,
          customMetadata: entry.customMetadata,
          etag: entry.etag,
        };
      }),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
      delimitedPrefixes: Array.from(delimitedPrefixes),
    };
  }

  async createMultipartUpload(key, options = {}) {
    const uploadId = `upload-${Math.random().toString(36).slice(2)}`;
    this._multipart.set(uploadId, { key, parts: new Map(), options });
    return this._handle(uploadId, key);
  }

  resumeMultipartUpload(key, uploadId) {
    return this._handle(uploadId, key);
  }

  _handle(uploadId, key) {
    return {
      key,
      uploadId,
      uploadPart: (partNumber, value) =>
        this._uploadPart(uploadId, partNumber, value),
      complete: (parts) => this._complete(uploadId, parts),
      abort: () => this._abort(uploadId),
    };
  }

  async _uploadPart(uploadId, partNumber, value) {
    const mp = this._multipart.get(uploadId);
    if (!mp) throw new Error("mockStorage: unknown multipart uploadId");
    const bytes = await readAllBytes(value);
    mp.parts.set(partNumber, bytes);
    return { partNumber, etag: `part-${partNumber}` };
  }

  async _complete(uploadId, parts) {
    const mp = this._multipart.get(uploadId);
    if (!mp) throw new Error("mockStorage: unknown multipart uploadId");
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    let total = 0;
    for (const p of sorted)
      total += mp.parts.get(p.partNumber)?.byteLength || 0;
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const p of sorted) {
      const bytes = mp.parts.get(p.partNumber);
      if (bytes) {
        combined.set(bytes, offset);
        offset += bytes.byteLength;
      }
    }
    this.store.set(mp.key, {
      bytes: combined,
      httpMetadata: mp.options.httpMetadata || {},
      customMetadata: mp.options.customMetadata || {},
      uploaded: new Date(),
      etag: `complete-${uploadId}`,
    });
    this._multipart.delete(uploadId);
    return { key: mp.key, size: combined.byteLength };
  }

  async _abort(uploadId) {
    this._multipart.delete(uploadId);
  }
}

// Minimal stand-in for a DurableObjectState's `.storage` (used by
// DownloadManager) plus a no-op-ish waitUntil that captures the promise so
// tests can await background work explicitly.
export class MockDOStorage {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.get(key);
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(keys) {
    if (Array.isArray(keys)) {
      let count = 0;
      for (const k of keys) if (this.map.delete(k)) count++;
      return count;
    }
    const existed = this.map.has(keys);
    this.map.delete(keys);
    return existed;
  }
  async list(options = {}) {
    const { prefix = "" } = options;
    const result = new Map();
    for (const [k, v] of this.map) if (k.startsWith(prefix)) result.set(k, v);
    return result;
  }
}

export function createMockDOState() {
  const waitUntilPromises = [];
  return {
    storage: new MockDOStorage(),
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    },
    waitUntilPromises,
  };
}

export function createMockEnv(overrides = {}) {
  return {
    WEBDAV_STORAGE: new MockR2Bucket(),
    WEBDAV_USERNAME: "demo",
    WEBDAV_PASSWORD: "demo",
    // /api/* now fails closed without a configured key (see _worker.js),
    // so every test env needs one by default, same as the WebDAV creds
    // above. Tests that specifically want the "unconfigured" case pass
    // { APIKEYSECRET: undefined } to override this.
    APIKEYSECRET: "test-api-key",
    // Stand-in for the Workers static-assets binding that serves the admin
    // frontend at "/". Real content doesn't matter for tests that only
    // check *whether* a request was routed here vs. to WebDAV.
    ASSETS: {
      fetch: async () =>
        new Response("<html>mock frontend</html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    },
    ...overrides,
  };
}

export function basicAuthHeader(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

// Builds a Request pre-authenticated for the given mock env's configured
// API key (AUTH_KEY/APIKEYSECRET), so tests don't need to know or repeat
// that key at every call site. Pass a key explicitly in `init.headers` to
// override (e.g. to test a wrong/missing key).
export function authedRequest(env, url, init = {}) {
  const headers = new Headers(init.headers || {});
  const key = env.AUTH_KEY || env.APIKEYSECRET;
  if (key && !headers.has("x-api-key") && !headers.has("X-Api-Key")) {
    headers.set("x-api-key", key);
  }
  return new Request(url, { ...init, headers });
}
