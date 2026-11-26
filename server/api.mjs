// The whole PHP "api.php?action=NAME" front controller as one handler. /api.php is kept, so the pages need no changes.
import { makeCtx, finish, jsonResponse, Out, out, sessionCookie } from './lib/core.mjs';
import { Conflict } from './lib/store.mjs';
import { routes as shop } from './lib/modules/shop.mjs';
import { routes as staff } from './lib/modules/staff.mjs';
import { routes as mpesa } from './lib/modules/mpesa.mjs';
import { routes as sales } from './lib/modules/sales.mjs';
import { routes as invoices } from './lib/modules/invoices.mjs';
import { routes as quotes } from './lib/modules/quotes.mjs';
import { routes as hr } from './lib/modules/hr.mjs';
import { routes as chat } from './lib/modules/chat.mjs';
import { invoicePage, quotePage } from './lib/pages.mjs';

const TABLE = { ...shop, ...staff, ...mpesa, ...sales, ...invoices, ...quotes, ...hr, ...chat };

async function attempt(req, context) {
  let c;
  try {
    c = await makeCtx(req, context);
    const act = c.get('action');
    const fn = Object.prototype.hasOwnProperty.call(TABLE, act) ? TABLE[act] : null;
    if (!fn) out({ error: 'Unknown action.' }, 404);
    await fn(c);
    out({ error: 'Unknown action.' }, 404); // a handler normally ends the request with out()
  } catch (e) {
    if (e instanceof Out) {
      if (e.raw) { const h = new Headers({ 'Cache-Control': 'no-store', ...e.raw.headers }); h.append('Set-Cookie', sessionCookie(c)); return finish(c, new Response(e.raw.body, { status: e.code, headers: h })); }
      return finish(c, jsonResponse(c, e.data, e.code));
    }
    if (e instanceof Conflict) throw e;
    console.error(e);
    if (c) { try { await finish(c, null); } catch (x) {} }
    const msg = e instanceof Conflict ? '' : /database|blob|sqlite|sql\.js|wasm/i.test(String(e.message)) ? 'The database could not be opened. See the Railway deploy logs.' : 'Server error. See the Railway deploy logs.';
    const h = { 'Content-Type': 'application/json' };
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: h });
  }
}

export default async (req, context) => {
  // Two requests can change the database at the same moment; the later one is simply run again on the newer data.
  for (let i = 0; i < 4; i++) {
    try { return await attempt(req.clone(), context); }
    catch (e) { if (!(e instanceof Conflict)) throw e; await new Promise(r => setTimeout(r, 80 + Math.random() * 220)); }
  }
  return new Response(JSON.stringify({ error: 'The shop is busy right now. Please try again.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
};


// The public, printable invoice and quotation pages (/invoice.php?t=TOKEN, /quote.php?t=TOKEN).
export async function page(req, context, kind) {
  let c;
  try {
    c = await makeCtx(req, context);
    const [code, html] = await (kind === 'quote' ? quotePage : invoicePage)(c);
    const h = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' });
    return await finish(c, new Response(html, { status: code, headers: h }));
  } catch (e) {
    console.error(e);
    if (c) { try { await finish(c, null); } catch (x) {} }
    return new Response('Server error. See the Railway deploy logs.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
