// Core runtime for the Railway (Node server) port: database, signed-cookie session, request helpers, settings, notifications, mail, uploads.
// It mirrors app/bootstrap.php + the *_lib.php files of the PHP version, so each module reads like the PHP controller it replaces.
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, saveDb, sessionSecret, UPLOAD_DIR } from './store.mjs';

// ---------- defaults (were constants in app/config.php; Admin > Settings overrides them) ----------
export const DEFAULTS = {
  SITE_NAME: 'Top Tack Safety Shop Limited', SITE_PHONE: '+254 721 373107', SITE_PHONE2: '+254 746 525398',
  SITE_EMAIL: 'info@toptacksafetyshop.co.ke', CURRENCY: 'KSh',
  MAP_BRANCHES: 'Main Branch (Mogadishu Road) | Mogadishu Road, Nairobi | -1.2830 | 36.8300\nNairobi Town Branch | Beaver Mall, Tom Mboya Street, Nairobi | -1.2860 | 36.8250\nSyokimau Branch | Gateway Mall, Mombasa Road, Syokimau | -1.3600 | 36.9330',
  SITE_ADDRESS: 'Main Branch: Mogadishu Road, Nairobi', INVOICE_PREFIX: 'INV-', BRAND_COLOR: '#ED152A', LOGO: 'img/logo.png',
  TAX_NAME: 'VAT', DEFAULT_TAX: 0, DUE_DAYS: 14, PAY_INFO: '', QUOTE_PREFIX: 'QUO-', QUOTE_VALID_DAYS: 30, QUOTE_TERMS: '',
  ADMIN_SIGNUP_CODE: process.env.ADMIN_SIGNUP_CODE || '', SITE_URL: process.env.SITE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''),
};

// ---------- control flow: out() ends the request, like PHP's out() ----------
export class Out extends Error {
  constructor(data, code = 200, raw = null) { super('out'); this.data = data; this.code = code; this.raw = raw; }
}
export const out = (d, c = 200) => { throw new Out(d, c); };
export const rawOut = (body, headers = {}, code = 200) => { throw new Out(null, code, { body, headers }); };

// ---------- database (SQLite file on the Railway volume; the SQL written for PostgreSQL is translated on the fly) ----------
const BOOLS = new Set(['active', 'must_change', 'pending', 'needs_review', 'best_seller', 'oversold', 'restock', 'cancel']);
const pgVal = v => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v);
function translate(c, sql) {
  const m = Math.round(tzOffset(Math.floor(Date.now() / 1000), appTz(c)) / 60), off = (m >= 0 ? '+' : '') + m + ' minutes';
  return sql
    .replace(/COALESCE\(json_agg\(json_build_object\(([^()]*)\)\),'\[\]'::json\)/gi, "COALESCE(json_group_array(json_object($1)),'[]')")
    .replace(/extract\(epoch from ([\w.]+)\)(::bigint)?/gi, "CAST(strftime('%s',$1) AS INTEGER)")
    .replace(/to_char\(([\w.]+),\s*'YYYY-MM-DD HH24:MI:SS'\)/gi, `strftime('%Y-%m-%d %H:%M:%S',$1,'${off}')`)
    .replace(/to_char\(([\w.]+),\s*'YYYY-MM-DD HH24:MI'\)/gi, `strftime('%Y-%m-%d %H:%M',$1,'${off}')`)
    .replace(/to_char\(([\w.]+),\s*'YYYY-MM'\)/gi, `strftime('%Y-%m',$1,'${off}')`)
    .replace(/to_char\(([\w.]+),\s*'YYYY-MM-DD'\)/gi, `strftime('%Y-%m-%d',$1,'${off}')`)
    .replace(/now\(\)\s*-\s*interval\s*'(\d+) (\w+)'/gi, "datetime('now','-$1 $2')")
    .replace(/now\(\)/gi, "datetime('now')")
    .replace(/\bFOR UPDATE\b/gi, '')
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/(\bLIKE\s+(?:\?|'[^']*'))(?!\s+ESCAPE)/gi, "$1 ESCAPE '\\'")
    .replace(/::(float8|float|int|bigint|numeric|text|json)\b/gi, '')
    .replace(/\bGREATEST\(/gi, 'max(').replace(/\bLEAST\(/gi, 'min(');
}
function fixRow(r) { for (const k in r) if (BOOLS.has(k) && (r[k] === 0 || r[k] === 1)) r[k] = r[k] === 1; return r; }
function dbErr(e) {
  const m = String(e && e.message || e);
  if (/UNIQUE constraint failed/i.test(m)) e.code = '23505';
  else if (/FOREIGN KEY constraint failed/i.test(m)) e.code = '23503';
  else if (/CHECK constraint failed|NOT NULL constraint failed/i.test(m)) e.code = '23514';
  else if (/no such table/i.test(m)) e.code = '42P01';
  return e;
}
async function dbOpen(c) {
  if (c._db) return;
  const o = await openDb(); c._db = o.db; c._etag = o.fresh ? null : o.etag; if (o.fresh) c._dirty = true;
}
function dbApi(c) {
  const run = async (sql, p = []) => {
    await dbOpen(c);
    const q = translate(c, sql);
    if (!/^\s*(select|with|pragma)\b/i.test(q)) c._dirty = true;
    let st;
    try {
      st = c._db.prepare(q); if (p.length) st.bind(p.map(pgVal));
      const rows = []; while (st.step()) rows.push(fixRow(st.getAsObject()));
      return { rows, rowCount: c._db.getRowsModified() };
    } catch (e) { throw dbErr(e); } finally { if (st) st.free(); }
  };
  c.run = run;
  c.all = async (s, p) => (await run(s, p)).rows;
  c.one = async (s, p) => (await run(s, p)).rows[0] || null;
  c.val = async (s, p) => { const r = (await run(s, p)).rows[0]; return r ? Object.values(r)[0] : null; };
  c.exec = async (s, p) => (await run(s, p)).rowCount;
  c.tx = async fn => {
    await run('BEGIN');
    try { const r = await fn(); await run('COMMIT'); return r; }
    catch (e) { try { await run('ROLLBACK'); } catch (_) {} throw e; }
  };
}

// ---------- settings (table `settings` wins over defaults) ----------
export async function settings(c) {
  if (c._settings) return c._settings;
  c._settings = {};
  try { for (const r of await c.all('SELECT k,v FROM settings')) c._settings[r.k] = r.v; } catch (e) {}
  return c._settings;
}
export function cfg(c, k, d = '') {
  const s = c._settings || {};
  if (Object.prototype.hasOwnProperty.call(s, k)) return s[k];
  return Object.prototype.hasOwnProperty.call(DEFAULTS, k) ? DEFAULTS[k] : d;
}
export function validTz(t) { try { new Intl.DateTimeFormat('en', { timeZone: t }); return true; } catch (e) { return false; } }
export function appTz(c) { let t = String(cfg(c, 'BH_TZ', '') || cfg(c, 'TIMEZONE', '')); return t && validTz(t) ? t : 'Africa/Nairobi'; }
export const tzList = () => (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []);

// ---------- small PHP-like helpers ----------
export const str = (c, k) => String(c.in[k] ?? '').trim();
export const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
export const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
export const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const money2 = n => (Math.round(num(n) * 100) / 100).toFixed(2);
export const numberFormat = (n, d = 2) => num(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const mbSub = (s, a, b) => Array.from(String(s)).slice(a, a + b).join('');
export const hashPw = pw => bcrypt.hash(pw, 10);
export const verifyPw = (pw, h) => { try { return h ? bcrypt.compare(String(pw), h) : false; } catch (e) { return false; } };
export const rnd = n => crypto.randomBytes(n).toString('hex');
export const todayStr = c => new Intl.DateTimeFormat('en-CA', { timeZone: appTz(c) }).format(new Date());
export function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }
export const post = c => { if (c.method !== 'POST' || !String(c.req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) out({ error: 'POST with JSON required.' }, 405); };
export const mailList = s => [...new Set(String(s || '').split(/[,;\s]+/).filter(Boolean).filter(isEmail))];

// CSV safety, as in the PHP code
export const cx = v => { v = String(v ?? ''); return v !== '' && '=+-@\t\r'.includes(v[0]) ? "'" + v : v; };
export const ix = v => { v = String(v ?? '').trim(); return v.length > 1 && v[0] === "'" && '=+-@'.includes(v[1]) ? v.slice(1) : v; };
export const inum = v => { v = String(v ?? '').replace(/[^0-9.\-]/g, ''); if (v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : false; };
export const csvCell = v => { v = String(v ?? ''); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
export const imgOk = v => v !== '' && !v.includes('..') && /^(https?:\/\/\S+|[\w./-]+)$/.test(v);

// ---------- session: a signed cookie (replaces PHP sessions, which need a server) ----------
const SESSION_IDLE = 4 * 3600, SESSION_REMEMBER = 30 * 86400;
let SECRET = '';
const secret = () => SECRET;
const b64 = s => Buffer.from(s).toString('base64url');
const sign = p => crypto.createHmac('sha256', secret()).update(p).digest('base64url');
function readSession(c) {
  const cookies = Object.fromEntries(String(c.req.headers.get('cookie') || '').split(/;\s*/).filter(Boolean).map(x => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
  const raw = cookies[c.cookieName]; c.session = {};
  if (!raw) return;
  const [p, s] = raw.split('.');
  if (!p || !s) return;
  const good = sign(p), a = Buffer.from(s), b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    const lim = d.rem ? SESSION_REMEMBER : SESSION_IDLE;
    if (d.t && Date.now() / 1000 - d.t > lim) return;
    c.session = d;
  } catch (e) {}
}
export function sessionCookie(c) {
  const d = { ...c.session, t: Math.floor(Date.now() / 1000) };
  const empty = !d.uid && !(d.cart && Object.keys(d.cart).length);
  const base = `${c.cookieName}=`;
  const flags = `; Path=/; HttpOnly; SameSite=Lax${c.https ? '; Secure' : ''}`;
  if (empty) return base + '; Max-Age=0' + flags;
  const p = b64(JSON.stringify(d));
  return base + p + '.' + sign(p) + flags + (d.rem ? `; Max-Age=${SESSION_REMEMBER}` : '');
}
export function rememberSession(c) { c.session.rem = c.in.remember === true || c.in.remember === 'true' || c.in.remember === 1 || c.in.remember === '1' ? 1 : 0; }

// ---------- request context ----------
export async function makeCtx(req, context) {
  const url = new URL(req.url);
  const c = { req, context, url, method: req.method, get: (k, d = '') => url.searchParams.get(k) ?? d, in: {} };
  c.https = url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  c.cookieName = c.https ? '__Host-store' : 'store_sid';
  c.ip = req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || context?.ip || '';
  dbApi(c); SECRET = await sessionSecret();
  readSession(c);
  if (c.method === 'POST' && String(req.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    try { const j = JSON.parse(await req.text()); c.in = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { c.in = {}; }
  }
  await settings(c);
  return c;
}
export async function finish(c, res) {
  if (c._db) { try { if (c._dirty) await saveDb(c); } finally { try { c._db.close(); } catch (e) {} c._db = null; c._dirty = false; } }
  const tasks = c._later || []; c._later = [];
  if (tasks.length) {
    const p = (async () => {
      for (const fn of tasks) { try { await fn(); } catch (e) { console.error('background task failed:', e.message); } }
      if (c._db) { try { if (c._dirty) await saveDb(c); } catch (e) { console.error('background save failed:', e.message); } try { c._db.close(); } catch (e) {} c._db = null; c._dirty = false; }
    })();
    if (c.context?.waitUntil) c.context.waitUntil(p); else await p;
  }
  return res;
}
export function jsonResponse(c, data, code = 200, extra = {}) {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...extra });
  h.append('Set-Cookie', sessionCookie(c));
  return new Response(JSON.stringify(data), { status: code, headers: h });
}

// ---------- the signed-in user (re-read on every request so switching an account off takes effect at once) ----------
export async function meRow(c) {
  if (c._me !== undefined) return c._me;
  const id = c.session.uid;
  if (!id) return (c._me = null);
  const r = await c.one('SELECT id,email,name,phone,role,active,must_change,photo FROM users WHERE id=?', [id]);
  if (!r || !r.active) { c.session = { cart: c.session.cart }; return (c._me = null); }
  return (c._me = { id: +r.id, email: r.email, name: r.name, phone: r.phone, role: r.role, must_change: !!r.must_change, photo: r.photo || '' });
}
export const uid = async c => (await meRow(c))?.id || null;
export const role = async c => (await meRow(c))?.role || null;
export function uJson(u) { const a = { id: +u.id, email: u.email, name: u.name, role: u.role, is_admin: u.role === 'admin', must_change: !!u.must_change, photo: String(u.photo || '') }; if (u.role === 'admin' || u.role === 'worker') a.home = u.role === 'admin' ? 'admin.html' : 'worker.html'; return a; }
export async function need(c, roles, allowChange = false) {
  const u = await meRow(c);
  if (!u) out({ error: 'Sign in first.' }, 401);
  if (!roles.includes(u.role)) out({ error: roles.length === 1 && roles[0] === 'admin' ? 'Admins only.' : 'Not allowed for this account.' }, 403);
  if (u.must_change && !allowChange) out({ error: 'Set your own password first.', must_change: true }, 403);
  return u;
}
export const admin = c => need(c, ['admin']);
export const staff = c => need(c, ['admin', 'worker']);
export const newPw = pw => { if (String(pw).length < 8) out({ error: 'The password must be at least 8 characters.' }, 422); };

// ---------- sign-in throttling ----------
export async function throttle(c, k, max = 8) {
  const n = await c.val("SELECT COUNT(*) FROM login_attempts WHERE k=? AND at>now()-interval '15 minutes'", [k]);
  if (+n >= max) out({ error: 'Too many failed attempts. Wait 15 minutes and try again.' }, 429);
}
export async function failTry(c, k) {
  await c.run('INSERT INTO login_attempts(k) VALUES(?)', [k]);
  if (Math.random() < 0.05) await c.run("DELETE FROM login_attempts WHERE at<now()-interval '1 day'");
}
export async function signIn(c, roles, wrongRole) {
  const e = str(c, 'email').toLowerCase(), k1 = 'e:' + e, k2 = 'i:' + c.ip;
  await throttle(c, k1); await throttle(c, k2, 40);
  const u = await c.one('SELECT id,email,name,password_hash,role,active,must_change,photo FROM users WHERE email=?', [e]);
  if (!u || u.password_hash === '' || !(await verifyPw(String(c.in.password ?? ''), u.password_hash))) { await failTry(c, k1); await failTry(c, k2); out({ error: 'Incorrect email or password.' }, 401); }
  if (!roles.includes(u.role)) out({ error: wrongRole }, 403);
  if (!u.active) out({ error: 'This account has been switched off. Please contact the store admin.' }, 403);
  await c.run('DELETE FROM login_attempts WHERE k=?', [k1]);
  await c.run('UPDATE users SET last_login=now() WHERE id=?', [u.id]);
  c.session = { uid: +u.id, cart: c.session.cart || {} }; rememberSession(c); c._me = undefined;
  u.must_change = !!u.must_change; return u;
}

// ---------- products and the cart ----------
export const PCOLS = 'id,name,descr,price,was,emoji,image,dept,stock,sku,cost,reorder_level';
export const prod = r => ({ id: +r.id, name: r.name, descr: r.descr, price: num(r.price), was: num(r.was), emoji: r.emoji, image: r.image, dept: r.dept, stock: +r.stock });
export const prodA = r => ({ ...prod(r), sku: r.sku, cost: r.cost === null || r.cost === undefined ? null : num(r.cost), reorder_level: +r.reorder_level });
export async function cart(c) {
  const ids = Object.keys(c.session.cart || {}).map(Number).filter(Boolean);
  const items = []; let cents = 0, n = 0;
  if (ids.length) {
    const rows = await c.all(`SELECT id,name,price,emoji,image FROM products WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids);
    for (const r of rows) { r.id = +r.id; r.qty = c.session.cart[r.id]; r.price = num(r.price); cents += Math.round(r.price * 100) * r.qty; n += r.qty; items.push(r); }
  }
  return { items, total: cents / 100, count: n };
}
// Every stock change is logged (call inside the same transaction as the change).
export const mv = (c, pid, name, kind, chg, after, price = null, oid = null, note = '', actor = null) =>
  c.run('INSERT INTO stock_movements(product_id,name,kind,qty_change,qty_after,unit_price,order_id,note,user_id) VALUES(?,?,?,?,?,?,?,?,?)',
    [pid, name, kind, chg, after, price === null ? null : money2(price), oid, mbSub(note, 0, 200), actor]);

// ---------- notifications (the bell) ----------
export async function nfAdd(c, aud, userId, kind, title, body = '', link = '') {
  try {
    await c.run('INSERT INTO notifications(aud,user_id,kind,title,body,link) VALUES(?,?,?,?,?,?)', [aud, userId || null, kind, mbSub(title, 0, 140), mbSub(body, 0, 300), mbSub(link, 0, 80)]);
    if (Math.random() < 1 / 60) await c.run("DELETE FROM notifications WHERE created_at<now()-interval '90 days'");
  } catch (e) { console.error('notification:', e.message); }
}
export const nfMoney = (c, n) => cfg(c, 'CURRENCY', '$') + numberFormat(n, 2);
export async function nfList(c) {
  const u = (await uid(c)) || 0, r = u ? await role(c) : 'guest'; let w, p = [];
  if (r === 'admin') { w = "kind NOT LIKE 'mine\\_%' OR user_id=?"; p = [u]; }
  else if (r === 'worker') { w = "aud IN('staff','customers') OR user_id=?"; p = [u]; }
  else if (r === 'customer') { w = "aud='customers' OR user_id=?"; p = [u]; }
  else w = "aud='customers'";
  const rows = await c.all(`SELECT id,kind,title,body,link,extract(epoch from created_at)::bigint AS ts FROM notifications WHERE (${w}) ORDER BY id DESC LIMIT 30`, p);
  out({ items: rows.map(x => ({ id: +x.id, kind: x.kind, title: x.title, body: x.body, link: x.link, ts: +x.ts })), now: Math.floor(Date.now() / 1000) });
}

// ---------- till payment ----------
export const tillNo = c => String(cfg(c, 'TILL_NUMBER', '')).trim();

// ---------- business hours (order target / SLA) ----------
function tzParts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {}; for (const p of f.formatToParts(new Date(ts * 1000))) o[p.type] = p.value; return o;
}
function tzOffset(ts, tz) { const o = tzParts(ts, tz); return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) / 1000 - ts; }
function localMidnight(y, m, d, tz) { const g = Date.UTC(y, m - 1, d) / 1000; return g - tzOffset(g, tz); }
export function bhMinutes(c, from, to) {
  if (to <= from) return 0;
  const tz = appTz(c);
  const hm = (v, d) => { const p = String(v).split(':'); return p.length === 2 ? (+p[0] * 60 + +p[1]) : d; };
  const st = hm(cfg(c, 'BH_START', '08:00'), 480), en = hm(cfg(c, 'BH_END', '17:00'), 1020);
  const days = String(cfg(c, 'BH_DAYS', '1,2,3,4,5')).split(',').filter(Boolean), hol = new Set(String(cfg(c, 'BH_HOLIDAYS', '')).split(',').filter(Boolean));
  const o = tzParts(from, tz); let y = +o.year, m = +o.month, d = +o.day, tot = 0;
  for (let n = 0; n < 800; n++) {
    const cur = localMidnight(y, m, d, tz); if (cur >= to) break;
    const dow = ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1, ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (days.includes(String(dow)) && !hol.has(ds)) { const a = Math.max(from, cur + st * 60), b = Math.min(to, cur + en * 60); if (b > a) tot += Math.floor((b - a) / 60); }
    const nx = new Date(Date.UTC(y, m - 1, d + 1)); y = nx.getUTCFullYear(); m = nx.getUTCMonth() + 1; d = nx.getUTCDate();
  }
  return tot;
}

// ---------- map branches + website content ----------
export function mapBranches(c) {
  const o = [];
  for (const ln of String(cfg(c, 'MAP_BRANCHES', '')).split(/\r?\n/)) {
    const p = ln.split('|').map(x => x.trim());
    if (p.length < 4 || p[0] === '' || isNaN(p[2]) || isNaN(p[3]) || p[2] === '' || p[3] === '') continue;
    o.push({ name: p[0], address: p[1], lat: +p[2], lng: +p[3] });
  }
  return o;
}
export const CONTENT_KEYS = { hero_t1: 60, hero_t2: 60, hero_sub: 200, hero_btn1: 40, hero_btn2: 40, hero_s1: 40, hero_s2: 40, hero_img1: 300, hero_img2: 300, hero_img3: 300, hero_img4: 300,
  trust1_t: 50, trust1_s: 90, trust2_t: 50, trust2_s: 90, trust3_t: 50, trust3_s: 90, trust4_t: 50, trust4_s: 90, best_title: 60, all_title: 60,
  quote_h: 90, quote_p: 300, quote_btn: 40, quote_b1: 40, quote_b2: 40, quote_b3: 40, quote_img: 300, hours: 400, footer_tag: 120, news_blurb: 160, search_ph: 80, whatsapp: 40,
  faq_about: 1200, faq_ship: 1200, faq_ret: 1200, faq_pay: 1200, faq_bulk: 1200 };
export function contentGet(c) {
  let j; try { j = JSON.parse(String(cfg(c, 'SITE_CONTENT', ''))); } catch (e) { j = null; }
  if (!j || typeof j !== 'object') return {};
  return Object.fromEntries(Object.entries(j).filter(([k]) => k in CONTENT_KEYS));
}
export async function contentSave(c, inp) {
  const o = {};
  for (const [k, len] of Object.entries(CONTENT_KEYS)) {
    if (!(k in inp)) continue; const v = String(inp[k] ?? '').trim();
    if (k.endsWith('_img') && v !== '' && !imgOk(v)) out({ error: 'A photo path or web address isn’t valid. Use the Upload button, or a path like img/logo.png.' }, 422);
    if (k === 'hours' && v !== '') for (const ln of v.split(/\r?\n/)) if (ln.trim() !== '' && ln.split('|').length < 2) out({ error: 'Opening hours: write each line like  Mon – Fri: | 8:00 AM - 5:00 PM' }, 422);
    if (k === 'whatsapp' && v !== '' && v.replace(/\D/g, '').length < 9) out({ error: 'The WhatsApp number looks too short. Use the international form, like +254 721 373107.' }, 422);
    o[k] = mbSub(v, 0, len);
  }
  await c.run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v', ['SITE_CONTENT', JSON.stringify(o)]);
}

// ---------- uploaded photos live on the volume (UPLOAD_DIR); server.mjs serves /img/uploads/* from there ----------
const upPath = key => path.join(UPLOAD_DIR, key);
export const upOk = p => /^img\/uploads\/[a-f0-9]{16}\.(jpg|png|webp|gif)$/.test(String(p || ''));
export const dpOk = p => /^img\/uploads\/avatars\/[a-f0-9]{16}\.(jpg|png|webp|gif)$/.test(String(p || ''));
export async function blobDrop(p) { try { fs.unlinkSync(upPath(String(p).replace(/^img\/uploads\//, ''))); } catch (e) {} }
export async function upGc(c, paths) {
  for (const p of [...new Set(paths)]) {
    if (!upOk(p)) continue;
    if (!(await c.val('SELECT 1 FROM products WHERE image=? LIMIT 1', [p]))) await blobDrop(p);
  }
}
export function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 6 && buf.slice(0, 3).toString() === 'GIF') return 'gif';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
export const MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
// Reads the multipart "photo" field, checks it is a real image, saves it to the volume and returns its public path.
export async function savePhoto(c, folder = '') {
  if (c.method !== 'POST' || c.req.headers.get('x-requested-with') !== 'fetch') out({ error: 'Upload with POST required.' }, 405);
  let fd; try { fd = await c.req.formData(); } catch (e) { out({ error: 'Choose a photo first.' }, 422); }
  const f = fd.get('photo');
  if (!f || typeof f === 'string' || !f.size) out({ error: 'Choose a photo first.' }, 422);
  if (f.size > 8 * 1024 * 1024) out({ error: 'The photo is too big (limit about 8 MB). Use a smaller one.' }, 422);
  const buf = Buffer.from(await f.arrayBuffer()), ext = sniffImage(buf);
  if (!ext) out({ error: 'Use a JPG, PNG, WebP or GIF photo.' }, 422);
  const name = rnd(8) + '.' + ext, key = (folder ? folder + '/' : '') + name;
  fs.mkdirSync(path.dirname(upPath(key)), { recursive: true }); fs.writeFileSync(upPath(key), buf);
  return 'img/uploads/' + key;
}

// ---------- email (SMTP settings from Admin > Settings; nodemailer replaces the hand-made SMTP client) ----------
export async function mailSend(c, to, subject, body, replyTo = '') {
  const host = String(cfg(c, 'SMTP_HOST', '')).trim(), user = String(cfg(c, 'SMTP_USER', '')).trim(), pass = String(cfg(c, 'SMTP_PASS', ''));
  if (!host) throw new Error('Mail is not set up. Fill in the SMTP host, user and password in Admin > Settings > Order emails.');
  const secure = String(cfg(c, 'SMTP_SECURE', 'tls')).toLowerCase();
  const port = +cfg(c, 'SMTP_PORT', 0) || (secure === 'ssl' ? 465 : 587);
  const from = mailList(cfg(c, 'MAIL_FROM', ''))[0] || mailList(user)[0] || 'orders@localhost';
  const t = nodemailer.createTransport({ host, port, secure: secure === 'ssl', requireTLS: secure === 'tls', ignoreTLS: secure === 'none', auth: user ? { user, pass } : undefined, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
  await t.sendMail({ from: { name: String(cfg(c, 'SITE_NAME', 'Store')).replace(/[\r\n]+/g, ' '), address: from }, to, subject: String(subject).replace(/[\r\n]+/g, ' '), text: String(body), replyTo: replyTo && isEmail(replyTo) ? replyTo : undefined });
}
export async function notifyOrder(c, oid) {
  const to = mailList(cfg(c, 'ORDER_EMAIL', '')); if (!to.length) return;
  const o = await c.one('SELECT o.*,u.email AS cemail FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?', [oid]); if (!o) return;
  const items = await c.all('SELECT name,unit_price,qty FROM order_items WHERE order_id=? ORDER BY id', [oid]);
  const cur = cfg(c, 'CURRENCY', '$');
  const lines = items.map(r => `  ${r.qty} x ${r.name} @ ${cur}${numberFormat(r.unit_price)} = ${cur}${numberFormat(r.qty * num(r.unit_price))}`);
  const base = String(cfg(c, 'SITE_URL', '')).replace(/\/$/, '') || `${c.url.protocol}//${c.url.host}`;
  const body = `New order #${o.id}\r\n\r\nCustomer: ${o.name}\r\nPhone: ${o.phone}\r\nEmail: ${o.cemail}\r\nAddress: ${o.address}\r\nPayment: ${o.payment}\r\n` + (o.note ? `Note: ${o.note}\r\n` : '') + `\r\nItems:\r\n${lines.join('\r\n')}\r\n\r\nTotal: ${cur}${numberFormat(o.total)}\r\n\r\nManage this order: ${base}/admin.html\r\n`;
  await mailSend(c, to, `New order #${o.id} - ${o.name} - ${cur}${numberFormat(o.total)}`, body, o.cemail);
}
// Runs after the response when the platform allows it, so a slow mail server never holds up an order.
export function later(c, fn) { (c._later ||= []).push(fn); }
