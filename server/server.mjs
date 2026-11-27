// Top Tack Safety Shop: one Node server for Railway. Serves the pages in /public, the API at /api.php (and /api),
// uploaded photos from the volume at /img/uploads/*, and a health check at /health.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import api, { page } from './api.mjs';
import { openDb, saveDb, UPLOAD_DIR } from './lib/store.mjs';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = +process.env.PORT || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' };

// Requests that touch the database run one at a time, so two saves can never overwrite each other.
let chain = Promise.resolve();
const serial = fn => { const r = chain.then(fn, fn); chain = r.catch(() => {}); return r; };

const pending = new Set();
const context = { waitUntil: p => { pending.add(p); p.finally(() => pending.delete(p)); } };

function toRequest(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const url = `${proto}://${req.headers.host || 'localhost'}${req.url}`;
  const init = { method: req.method, headers: req.headers };
  if (!['GET', 'HEAD'].includes(req.method)) { init.body = Readable.toWeb(req); init.duplex = 'half'; }
  return new Request(url, init);
}
async function sendWeb(res, r) {
  const headers = {};
  for (const [k, v] of r.headers) if (k !== 'set-cookie') headers[k] = v;
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(r.status, { ...SEC, ...headers });
  res.end(Buffer.from(await r.arrayBuffer()));
}
function sendFile(req, res, file, extra = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, ...extra });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    let p; try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end('Bad request'); }

    if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

    if (p === '/api.php' || p === '/api') {
      const r = await serial(() => api(toRequest(req), context));
      return sendWeb(res, r);
    }

    if (p === '/invoice.php' || p === '/quote.php') { // private-link invoice / quotation pages
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
      const r = await serial(() => page(toRequest(req), context, p === '/quote.php' ? 'quote' : 'invoice'));
      return sendWeb(res, r);
    }

    if (p === '/setup') { // optional: creates the database right now. Safe to open again.
      const r = await serial(async () => {
        const o = await openDb();
        if (o.fresh) await saveDb({ _db: o.db, _etag: null });
        const n = o.db.exec('SELECT COUNT(*) FROM products')[0].values[0][0];
        return `Top Tack setup\n\n${o.fresh ? 'Database created' : 'Database already exists'} (${n} products).\n\nNext: open /admin.html and choose "Create admin account".\n`;
      });
      res.writeHead(200, { ...SEC, 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(r);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }

    if (p.startsWith('/img/uploads/')) { // photos uploaded from the admin pages (live on the volume)
      const key = p.slice('/img/uploads/'.length);
      if (!/^(avatars\/)?[a-f0-9]{16}\.(jpg|png|webp|gif)$/.test(key)) { res.writeHead(404); return res.end('Not found'); }
      return sendFile(req, res, path.join(UPLOAD_DIR, key), { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }

    if (p.endsWith('/')) p += 'index.html';
    else if (!path.extname(p) && fs.existsSync(path.join(PUBLIC, p + '.html'))) p += '.html'; // clean URLs: /admin -> admin.html, /worker -> worker.html
    const file = path.normalize(path.join(PUBLIC, p));
    if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    return sendFile(req, res, file, { 'Cache-Control': p.startsWith('/img/') ? 'public, max-age=86400' : 'no-cache' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server error. See the Railway deploy logs.' }));
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`Top Tack listening on ${PORT}`));
const stop = () => server.close(async () => { await Promise.allSettled([...pending]); process.exit(0); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
