// Ingest Worker for the cph-twin-data R2 bucket (tools/hosting/upload_r2.py talks to it). The Cloudflare REST object API is capped
// at ~4 requests/s, far too slow for 160k facade atlases; a Worker with an R2 binding is not. Every call needs the x-ingest-key
// header (secret INGEST_KEY). The Worker never serves data publicly: readers use the bucket's r2.dev URL.
//
//   GET  /list?prefix=&cursor=        -> { keys: [[key, size, etag]], cursor }       (one page of up to 1000)
//   PUT  /put?key=                    body = object; Content-Type / Cache-Control / Content-Encoding headers are stored
//   POST /gcs-copy                    { bucket, token, cacheControl, items: [{ name, key, contentType }] } pulls each object from
//                                     Google Cloud Storage (Bearer token) into R2, 12 at a time -> { results: [{ key, ok, status|etag }] }
//   POST /delete                      { keys: [...] }
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

export default {
  async fetch(req, env) {
    if (!env.INGEST_KEY || req.headers.get('x-ingest-key') !== env.INGEST_KEY) return new Response('unauthorized', { status: 401 });
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/list') {
      const page = await env.BUCKET.list({ prefix: url.searchParams.get('prefix') || '', cursor: url.searchParams.get('cursor') || undefined, limit: 1000 });
      return json({ keys: page.objects.map((o) => [o.key, o.size, o.etag]), cursor: page.truncated ? page.cursor : null });
    }
    if (req.method === 'PUT' && url.pathname === '/put') {
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'key' }, 400);
      const httpMetadata = {};
      if (req.headers.get('content-type')) httpMetadata.contentType = req.headers.get('content-type');
      if (req.headers.get('cache-control')) httpMetadata.cacheControl = req.headers.get('cache-control');
      if (req.headers.get('content-encoding')) httpMetadata.contentEncoding = req.headers.get('content-encoding');
      const obj = await env.BUCKET.put(key, await req.arrayBuffer(), { httpMetadata });
      return json({ key, size: obj.size, etag: obj.etag });
    }
    if (req.method === 'POST' && url.pathname === '/gcs-copy') {
      const { bucket, token, cacheControl, items } = await req.json();
      const results = await pool(items, 12, async ({ name, key, contentType }) => {
        try {
          const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`, { headers: { authorization: `Bearer ${token}`, 'accept-encoding': 'identity' } });
          if (!r.ok) return { key, ok: false, status: r.status };
          const obj = await env.BUCKET.put(key, await r.arrayBuffer(), { httpMetadata: { contentType, cacheControl } });
          return { key, ok: true, etag: obj.etag, size: obj.size };
        } catch (e) { return { key, ok: false, status: String(e) }; }
      });
      return json({ results });
    }
    if (req.method === 'POST' && url.pathname === '/delete') {
      const { keys } = await req.json();
      await env.BUCKET.delete(keys);
      return json({ deleted: keys.length });
    }
    return new Response('not found', { status: 404 });
  }
};
