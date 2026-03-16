// ============================================================================
// HELPERS
// ============================================================================
const jsonOk = (data) => Response.json(data);
const jsonError = (msg, status = 400) => Response.json({ error: msg }, { status });
async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}
function baseName(key) { return key.split('/').filter(Boolean).pop() || key; }

// ============================================================================
// MAIN WORKER
// ============================================================================
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      // --- Serve frontend ---
      if (path === '/' || path === '/index.html') return env.ASSETS.fetch(request);

      // --- Public share (no auth) ---
      if (path.startsWith('/s/')) return handlePublicShare(url, env);

      // --- Auth gate for everything else ---
      const authKey = env.AUTH_KEY || env.APIKEYSECRET;
      if (authKey) {
        const k = url.searchParams.get('key') || request.headers.get('x-api-key');
        if (k !== authKey) return jsonError('Unauthorized', 401);
      }

      // --- File routes ---
      if (path === '/api/files' && method === 'GET') return handleListFiles(url, env);

      if (path === '/api/files/info' && method === 'GET') {
        const key = url.searchParams.get('key');
        if (!key) return jsonError('Missing key');
        const head = await env.DRIVE_BUCKET.head(key);
        if (!head) return jsonError('Not found', 404);
        return jsonOk({ key: head.key, size: head.size, uploaded: head.uploaded, httpMetadata: head.httpMetadata, customMetadata: head.customMetadata });
      }

      if (path === '/api/files/delete' && method === 'POST') {
        const body = await readBody(request);
        if (!body) return jsonError('Invalid body');
        const keys = Array.isArray(body.keys) ? body.keys : body.filename ? [body.filename] : [];
        if (!keys.length) return jsonError('No keys');
        // Also delete associated .folder markers if deleting folders
        await Promise.all(keys.map(k => env.DRIVE_BUCKET.delete(k)));
        return jsonOk({ deleted: keys.length });
      }

      if (path === '/api/files/rename' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.oldName || !body?.newName) return jsonError('Missing params');
        const src = await env.DRIVE_BUCKET.get(body.oldName);
        if (!src) return jsonError('Not found', 404);
        if (await env.DRIVE_BUCKET.head(body.newName)) return jsonError('Name already taken', 409);
        await env.DRIVE_BUCKET.put(body.newName, src.body, { 
          httpMetadata: src.httpMetadata, 
          customMetadata: src.customMetadata
        });
        await env.DRIVE_BUCKET.delete(body.oldName);
        return jsonOk({ status: 'renamed', oldName: body.oldName, newName: body.newName });
      }

      if (path === '/api/files/move' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.source || !body?.destination) return jsonError('Missing source or destination');
        const src = await env.DRIVE_BUCKET.get(body.source);
        if (!src) return jsonError('Source not found', 404);
        const destKey = body.destination.endsWith('/') ? body.destination + body.source.split('/').pop() : body.destination;
        if (await env.DRIVE_BUCKET.head(destKey)) return jsonError('Destination already exists', 409);
        await env.DRIVE_BUCKET.put(destKey, src.body, { 
          httpMetadata: src.httpMetadata, 
          customMetadata: src.customMetadata
        });
        await env.DRIVE_BUCKET.delete(body.source);
        return jsonOk({ status: 'moved', source: body.source, destination: destKey });
      }

      if (path === '/api/files/copy' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.source || !body?.destination) return jsonError('Missing source or destination');
        const src = await env.DRIVE_BUCKET.get(body.source);
        if (!src) return jsonError('Source not found', 404);
        const destKey = body.destination.endsWith('/') ? body.destination + body.source.split('/').pop() : body.destination;
        if (await env.DRIVE_BUCKET.head(destKey)) return jsonError('Destination already exists', 409);
        await env.DRIVE_BUCKET.put(destKey, src.body, { 
          httpMetadata: src.httpMetadata, 
          customMetadata: src.customMetadata
        });
        return jsonOk({ status: 'copied', source: body.source, destination: destKey });
      }

      if (path === '/api/files/mkdir' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.path) return jsonError('Missing path');
        const folderKey = body.path.endsWith('/') ? body.path : body.path + '/';
        await env.DRIVE_BUCKET.put(folderKey + '.emptydir', new Uint8Array(0), { customMetadata: { type: 'folder' } });
        return jsonOk({ created: folderKey });
      }

      if (path === '/api/upload' && (method === 'PUT' || method === 'POST')) {
        let filename = url.searchParams.get('filename');
        if (!filename) return jsonError('Missing filename');
        if (!filename.startsWith('/')) filename = '/' + filename;
        await env.DRIVE_BUCKET.put(filename, request.body, {
          httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' },
          customMetadata: { source: 'upload', timestamp: Date.now().toString() }
        });
        return jsonOk({ status: 'uploaded', filename });
      }

      if (path.startsWith('/get/')) {
        const filename = decodeURIComponent(path.slice(5));
        const obj = await env.DRIVE_BUCKET.get(filename);
        if (!obj) return new Response('Not found', { status: 404 });
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('Content-Disposition', `attachment; filename="${baseName(filename)}"`);
        headers.set('Content-Length', obj.size);
        return new Response(obj.body, { headers });
      }

      // --- Job routes ---
      if (path === '/api/jobs/init' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.sourceUrl || !body?.filename) return jsonError('Missing sourceUrl or filename');
        let filename = body.filename;
        if (!filename.startsWith('/')) filename = '/' + filename;
        if (!body.force) {
          const existing = await env.DRIVE_BUCKET.head(filename);
          if (existing) return jsonOk({ status: 'exists', filename, size: existing.size });
        }
        const jobId = crypto.randomUUID();
        const id = env.DOWNLOAD_MANAGER.idFromName(jobId);
        return env.DOWNLOAD_MANAGER.get(id).fetch(new Request('https://do/init', {
          method: 'POST', body: JSON.stringify({ sourceUrl: body.sourceUrl, filename, jobId })
        }));
      }

      if (path === '/api/jobs/chunk' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.jobId) return jsonError('Missing jobId');
        const id = env.DOWNLOAD_MANAGER.idFromName(body.jobId);
        return env.DOWNLOAD_MANAGER.get(id).fetch(new Request('https://do/chunk', { method: 'POST', body: JSON.stringify(body) }));
      }

      if (path === '/api/jobs/status' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.jobId) return jsonError('Missing jobId');
        const id = env.DOWNLOAD_MANAGER.idFromName(body.jobId);
        return env.DOWNLOAD_MANAGER.get(id).fetch(new Request('https://do/status'));
      }

      if (path === '/api/jobs/finish' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.jobId) return jsonError('Missing jobId');
        const id = env.DOWNLOAD_MANAGER.idFromName(body.jobId);
        return env.DOWNLOAD_MANAGER.get(id).fetch(new Request('https://do/finish', { method: 'POST' }));
      }

      if (path === '/api/jobs/abort' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.jobId) return jsonError('Missing jobId');
        const id = env.DOWNLOAD_MANAGER.idFromName(body.jobId);
        return env.DOWNLOAD_MANAGER.get(id).fetch(new Request('https://do/abort', { method: 'POST' }));
      }

      // --- Share routes ---
      if (path === '/api/shares' && method === 'GET') return handleListShares(env);
      if (path === '/api/shares/create' && method === 'POST') return handleCreateShare(request, env);
      if (path === '/api/shares/revoke' && method === 'POST') {
        const body = await readBody(request);
        if (!body?.token) return jsonError('Missing token');
        await env.DRIVE_BUCKET.delete(`.tokens/${body.token}`);
        return jsonOk({ revoked: true });
      }

      return jsonError('Not Found: ' + path, 404);
    } catch (e) {
      return jsonError('Internal Error: ' + e.message, 500);
    }
  }
};

// ============================================================================
// Route Handlers
// ============================================================================
async function handlePublicShare(url, env) {
  const code = url.searchParams.get('code') || '';
  const token = url.pathname.split('/')[2];
  if (!token) return new Response('Missing token', { status: 400 });
  const tokenObj = await env.DRIVE_BUCKET.get(`.tokens/${token}`);
  if (!tokenObj) return new Response('Invalid or expired link', { status: 404 });
  const meta = await tokenObj.json();
  if (meta.expires && Date.now() > meta.expires) {
    await env.DRIVE_BUCKET.delete(`.tokens/${token}`);
    return new Response('Link expired', { status: 410 });
  }
  if (code !== meta.code) return new Response('Invalid code', { status: 403 });
  const obj = await env.DRIVE_BUCKET.get(meta.filename);
  if (!obj) return new Response('File not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Disposition', `attachment; filename="${baseName(meta.filename)}"`);
  return new Response(obj.body, { headers });
}

async function handleListFiles(url, env) {
  const prefix = url.searchParams.get('prefix') || '';
  const delimiter = url.searchParams.get('delimiter') || '';
  const cursor = url.searchParams.get('cursor') || undefined;
  const search = (url.searchParams.get('search') || '').toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '500'), 1000);

  const opts = { limit, include: ['customMetadata', 'httpMetadata'] };
  if (prefix) opts.prefix = prefix;
  if (delimiter) opts.delimiter = delimiter;
  if (cursor) opts.cursor = cursor;

  const listed = await env.DRIVE_BUCKET.list(opts);

  let files = listed.objects
    .filter(o => !o.key.startsWith('.tokens/') && !o.key.startsWith('.jobs/') && !o.key.endsWith('.emptydir'))
    .map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded, httpMetadata: o.httpMetadata || {}, customMetadata: o.customMetadata || {} }));

  if (search) files = files.filter(f => f.key.toLowerCase().includes(search));

  const folders = (listed.delimitedPrefixes || []).filter(p => !p.startsWith('.') && p !== '/');

  return jsonOk({ files, folders, truncated: listed.truncated, cursor: listed.truncated ? listed.cursor : null });
}

async function handleListShares(env) {
  const listed = await env.DRIVE_BUCKET.list({ prefix: '.tokens/', limit: 200 });
  const shares = [];
  for (const obj of listed.objects) {
    try {
      const raw = await env.DRIVE_BUCKET.get(obj.key);
      const data = await raw.json();
      const token = obj.key.replace('.tokens/', '');
      shares.push({ token, filename: data.filename, code: data.code, expires: data.expires, created: data.created, expired: data.expires ? Date.now() > data.expires : false, url: `/s/${token}?code=${data.code}` });
    } catch {}
  }
  return jsonOk({ shares });
}

async function handleCreateShare(request, env) {
  const body = await readBody(request);
  if (!body?.filename) return jsonError('Missing filename');
  const hours = parseInt(body.hours ?? 24);
  const customCode = (body.customCode || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
  const code = customCode || crypto.randomUUID().replace(/-/g, '').substring(0, 8);
  const expires = hours >= 999 ? null : Date.now() + hours * 3600000;
  const token = btoa(body.filename).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  await env.DRIVE_BUCKET.put(`.tokens/${token}`, JSON.stringify({ filename: body.filename, expires, code, created: Date.now() }));
  return jsonOk({ token, code, url: `/s/${token}?code=${code}`, expires: expires ? new Date(expires).toISOString() : null });
}

// ============================================================================
// DURABLE OBJECT: DownloadManager
// ============================================================================
export class DownloadManager {
  constructor(state, env) { this.state = state; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    const cpuStart = performance.now();
    try {
      switch (url.pathname) {
        case '/init': return await this.doInit(request);
        case '/chunk': return await this.doChunk(request, cpuStart);
        case '/finish': return await this.doFinish();
        case '/status': return await this.doStatus();
        case '/abort': return await this.doAbort();
        default: return jsonError('Unknown DO route', 404);
      }
    } catch (e) {
      return jsonError('DO error: ' + e.message, 500);
    }
  }

  async doInit(request) {
    const { sourceUrl, filename, jobId } = await request.json();
    const CHUNK = 20 * 1024 * 1024;

    let head;
    try { head = await fetch(sourceUrl, { method: 'HEAD' }); }
    catch (e) { return jsonError('Cannot reach source: ' + e.message); }
    console.log("doInit, url: ",sourceUrl);
    console.log("doInit, filename: ",filename);
    console.log("doInit, jobId: ",jobId);

    const totalSize = parseInt(head.headers.get('content-length')) || 0;
    const contentType = head.headers.get('content-type') || 'application/octet-stream';

    let rangeOk = head.headers.get('accept-ranges') === 'bytes';
    console.log("doInit, head.headers: ",head.headers);
    console.log("doInit, rangeOk: ",rangeOk);
    console.log("doInit, totalSize: ",totalSize);
    
    if (!rangeOk && totalSize > 0) {
      try { rangeOk = (await fetch(sourceUrl, { headers: { Range: 'bytes=0-0' } })).status === 206; } catch {}
    }

    if (!rangeOk && totalSize === 0) {
      return jsonError('Cannot download: source does not support Range requests and Content-Length is unknown. Please use a source with known file size.');
    }

    if (!rangeOk || totalSize === 0 || totalSize < CHUNK) {
      await this.state.storage.put('status', { mode: 'single', status: 'downloading', filename, totalSize, started: Date.now() });
      this.state.waitUntil(this.singleStream(sourceUrl, filename, contentType));
      return jsonOk({ mode: 'single', totalSize, jobId });
    }

    const mp = await this.env.DRIVE_BUCKET.createMultipartUpload(filename, {
      httpMetadata: { contentType },
      customMetadata: { source: sourceUrl, timestamp: Date.now().toString() }
    });

    const ranges = [];
    let s = 0, p = 1;
    while (s < totalSize) { const e = Math.min(s + CHUNK - 1, totalSize - 1); ranges.push({ partNumber: p++, start: s, end: e }); s += CHUNK; }

    await this.state.storage.put('job', { uploadId: mp.uploadId, filename, sourceUrl, totalSize, totalParts: ranges.length });
    await this.state.storage.put('status', { mode: 'parallel', status: 'downloading', filename, totalSize, totalParts: ranges.length, completedParts: 0, bytesDownloaded: 0, started: Date.now() });

    return jsonOk({ mode: 'parallel', totalSize, ranges, jobId });
  }

  async doChunk(request, cpuStart) {
    try {
      const { partNumber, start, end } = await request.json();
      const job = await this.state.storage.get('job');
      if (!job) return jsonOk({ status: 'failed', error: 'No active job' });
      if (await this.state.storage.get('aborted')) return jsonOk({ status: 'failed', error: 'Job aborted' });

      const mp = this.env.DRIVE_BUCKET.resumeMultipartUpload(job.filename, job.uploadId);
      const res = await fetch(job.sourceUrl, { headers: { Range: `bytes=${start}-${end}` } });
      if (res.status !== 206 && res.status !== 200) {
        return jsonOk({ status: 'failed', error: 'Range request failed: ' + res.status });
      }

      const part = await mp.uploadPart(partNumber, res.body);
      await this.state.storage.put(`part_${partNumber}`, { partNumber, etag: part.etag });

      const chunkSize = end - start + 1;
      const status = await this.state.storage.get('status');
      if (status) {
        status.completedParts = (status.completedParts || 0) + 1;
        status.bytesDownloaded = (status.bytesDownloaded || 0) + chunkSize;
        await this.state.storage.put('status', status);
      }

      return jsonOk({ status: 'done', partNumber, chunkSize, cpuTime: performance.now() - cpuStart });
    } catch (e) {
      return jsonOk({ status: 'failed', error: e.message });
    }
  }

  async doFinish() {
    const job = await this.state.storage.get('job');
    if (!job) return jsonError('No active job', 404);

    const partEntries = await this.state.storage.list({ prefix: 'part_' });
    const parts = Array.from(partEntries.values()).sort((a, b) => a.partNumber - b.partNumber);
    if (!parts.length) return jsonError('No parts uploaded');

    const mp = this.env.DRIVE_BUCKET.resumeMultipartUpload(job.filename, job.uploadId);
    await mp.complete(parts);

    await this.state.storage.put('status', { mode: 'parallel', status: 'completed', filename: job.filename, totalSize: job.totalSize, totalParts: job.totalParts, completedParts: job.totalParts, finished: Date.now() });
    const delKeys = ['job', ...Array.from(partEntries.keys())];
    await this.state.storage.delete(delKeys);

    return jsonOk({ status: 'completed', filename: job.filename });
  }

  async doStatus() {
    const status = await this.state.storage.get('status');
    return jsonOk(status || { status: 'idle' });
  }

  async doAbort() {
    await this.state.storage.put('aborted', true);
    const job = await this.state.storage.get('job');
    if (job) { try { (this.env.DRIVE_BUCKET.resumeMultipartUpload(job.filename, job.uploadId)).abort(); } catch {} }
    await this.state.storage.put('status', { status: 'aborted' });
    await this.state.storage.delete('job');
    return jsonOk({ status: 'aborted' });
  }

  async singleStream(sourceUrl, filename, contentType) {
    try {
      const res = await fetch(sourceUrl);
      await this.env.DRIVE_BUCKET.put(filename, res.body, {
        httpMetadata: { contentType },
        customMetadata: { source: sourceUrl, timestamp: Date.now().toString() }
      });
      await this.state.storage.put('status', { mode: 'single', status: 'completed', filename, finished: Date.now() });
    } catch (e) {
      await this.state.storage.put('status', { mode: 'single', status: 'failed', filename, error: e.message });
    }
  }
}