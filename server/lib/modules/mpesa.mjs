// M-Pesa STK Push (Safaricom Daraja): port of app/mpesa_lib.php + app/modules/mpesa/MpesaController.php.
// Flow: m_pay sends the prompt to the customer's phone -> the customer enters their PIN -> Safaricom calls m_callback -> the order is marked paid (orders.paid_at).
// m_status lets the page poll, and asks Safaricom directly if the callback is late or never arrives.
// Credentials come from Railway variables (never from the settings table, so they cannot be read through Admin > Settings). See README-RAILWAY.md.
import crypto from 'node:crypto';
import { out, post, str, int, num, mbSub, cfg, tillNo, uid, role, need, nfAdd, nfMoney } from '../core.mjs';

const env = (k, d = '') => String(process.env[k] ?? d).trim();
const K = () => ({ env: env('MPESA_ENV', 'sandbox'), key: env('MPESA_CONSUMER_KEY'), secret: env('MPESA_CONSUMER_SECRET'), shortcode: env('MPESA_SHORTCODE'), passkey: env('MPESA_PASSKEY'),
  type: env('MPESA_TXN_TYPE', 'CustomerBuyGoodsOnline'), partyB: env('MPESA_PARTYB'), cbSecret: env('MPESA_CALLBACK_SECRET'), cbUrl: env('MPESA_CALLBACK_URL'), base: env('MPESA_BASE_URL') });
const siteUrl = c => String(cfg(c, 'SITE_URL', '')).replace(/\/$/, '');
const callbackUrl = (c, k = K()) => k.cbUrl || (siteUrl(c) ? `${siteUrl(c)}/api.php?action=m_callback&k=${encodeURIComponent(k.cbSecret)}` : '');
export const mpesaReady = c => { const k = K(); return !!(k.key && k.secret && k.shortcode && k.passkey && k.cbSecret && callbackUrl(c, k)); };
const base = k => (k.base ? k.base.replace(/\/$/, '') : k.env.toLowerCase() === 'live' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');

// 0712345678, 0112345678, +254712345678, 254712345678, 712345678 -> 254712345678. Returns '' when it is not a Kenyan mobile number.
export function mpesaPhone(p) {
  p = String(p).replace(/[\s\-().]/g, '');
  const m = p.match(/^\+?254([17]\d{8})$/) || p.match(/^0([17]\d{8})$/) || p.match(/^([17]\d{8})$/);
  return m ? '254' + m[1] : '';
}
// Daraja only takes whole shillings, so a total such as 1250.50 is asked as 1251 (rounded up; never less than the order total).
export const mpesaAmount = total => Math.ceil(Math.round(num(total) * 100) / 100 - 0.00001);

async function http(k, method, path, body, headers) {
  let res;
  try { res = await fetch(base(k) + path, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(method === 'POST' ? 25000 : 10000) }); }
  catch (e) { throw new Error('M-Pesa request failed: ' + (e.message || e)); }
  const raw = await res.text(); let j = {}; try { const x = JSON.parse(raw); if (x && typeof x === 'object') j = x; } catch (e) {}
  return [res.status, j, raw];
}
// OAuth token, kept in memory for ~50 minutes (Daraja tokens last an hour).
let TOKEN = { t: '', exp: 0 };
async function token(k) {
  if (TOKEN.t && TOKEN.exp > Date.now() / 1000 + 60) return TOKEN.t;
  const [code, j, raw] = await http(k, 'GET', '/oauth/v1/generate?grant_type=client_credentials', null, { Authorization: 'Basic ' + Buffer.from(k.key + ':' + k.secret).toString('base64') });
  if (code !== 200 || !j.access_token) { console.error('M-Pesa token failed: HTTP ' + code + ' ' + raw.slice(0, 300)); throw new Error('Could not get an M-Pesa access token. Check the consumer key and secret.'); }
  TOKEN = { t: String(j.access_token), exp: Date.now() / 1000 + (+j.expires_in || 3599) - 600 };
  return TOKEN.t;
}
// Daraja wants Nairobi time (EAT) for the timestamp, whatever timezone the shop displays.
const stamp = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  .formatToParts(new Date()).reduce((a, p) => (p.type === 'literal' ? a : a + p.value), '');
const password = (k, ts) => Buffer.from(k.shortcode + k.passkey + ts).toString('base64');

// Sends the payment prompt to the customer's phone. Returns Daraja's reply (MerchantRequestID, CheckoutRequestID...). Throws on any failure.
async function stkPush(c, phone, amount, ref, desc) {
  const k = K(), ts = stamp();
  // Till (Buy Goods): BusinessShortCode = your store/head-office number, PartyB = the till. Paybill: both are the paybill number.
  const partyB = k.partyB || (k.type === 'CustomerBuyGoodsOnline' && tillNo(c) !== '' ? tillNo(c) : k.shortcode);
  const body = { BusinessShortCode: k.shortcode, Password: password(k, ts), Timestamp: ts, TransactionType: k.type, Amount: amount, PartyA: phone, PartyB: partyB, PhoneNumber: phone, CallBackURL: callbackUrl(c, k), AccountReference: mbSub(ref, 0, 12), TransactionDesc: mbSub(desc, 0, 13) };
  const [code, j, raw] = await http(k, 'POST', '/mpesa/stkpush/v1/processrequest', body, { Authorization: 'Bearer ' + await token(k), 'Content-Type': 'application/json' });
  if (code !== 200 || String(j.ResponseCode ?? '') !== '0' || !j.CheckoutRequestID) {
    console.error('M-Pesa STK push rejected: HTTP ' + code + ' ' + raw.slice(0, 500));
    throw new Error(String(j.errorMessage ?? j.ResponseDescription ?? 'Safaricom did not accept the payment request.'));
  }
  return j;
}
// Asks Safaricom what happened to a prompt (used when the callback has not arrived). code null = still being processed.
async function stkQuery(checkoutId) {
  const k = K(), ts = stamp();
  const [, j] = await http(k, 'POST', '/mpesa/stkpushquery/v1/query', { BusinessShortCode: k.shortcode, Password: password(k, ts), Timestamp: ts, CheckoutRequestID: checkoutId }, { Authorization: 'Bearer ' + await token(k), 'Content-Type': 'application/json' });
  // While the customer is still looking at the prompt Daraja answers with an error body ("The transaction is being processed"): treat as pending.
  if (j.ResultCode === undefined || j.ResultCode === null) return { code: null, desc: String(j.errorMessage ?? '') };
  return { code: +j.ResultCode, desc: String(j.ResultDesc ?? '') };
}
const FAIL = { 1: 'Not enough M-Pesa balance.', 1032: 'You cancelled the payment request.', 1037: 'The request timed out. Please try again.', 2001: 'Wrong M-Pesa PIN entered.', 1019: 'The request expired. Please try again.', 1025: 'The prompt could not be sent. Please try again.', 9999: 'The prompt could not be sent. Please try again.' };
const failText = (code, desc) => FAIL[code] ?? (desc !== '' ? desc : 'The payment was not completed.');
const mask = p => (String(p).length >= 9 ? String(p).slice(0, 6) + '***' + String(p).slice(-3) : p);
const PENDING_SECS = 90; // a prompt this young is still live: do not send a second one
const AGE = "(CAST(strftime('%s','now') AS INTEGER)-CAST(strftime('%s',created_at) AS INTEGER))";

// The signed-in customer's own order (staff may use any order).
async function myOrder(c, id) {
  await need(c, ['customer', 'worker', 'admin']);
  const o = await c.one('SELECT id,user_id,status,total,phone,paid_at IS NOT NULL AS paid FROM orders WHERE id=?', [id]);
  if (!o || ((await role(c)) === 'customer' && +o.user_id !== (await uid(c)))) out({ error: 'Unknown order.' }, 404);
  return { ...o, paid: !!o.paid };
}
const ready = c => { if (!mpesaReady(c)) out({ error: 'M-Pesa payment is not available right now. Please pay with the till number or on delivery.' }, 503); };

// Records the outcome of one prompt. Safe to call twice (callback + status poll): the second call changes nothing.
async function settle(c, checkoutId, code, desc, meta) {
  let after = null;
  await c.tx(async () => {
    const p = await c.one('SELECT id,order_id,user_id,amount,status FROM mpesa_payments WHERE checkout_request_id=?', [checkoutId]);
    // A success found by the status query has no M-Pesa code yet; the callback that follows brings it, so keep it.
    if (p && p.status === 'success' && code === 0 && String(meta.MpesaReceiptNumber ?? '').trim() !== '') { await c.run('UPDATE mpesa_payments SET receipt=? WHERE id=? AND receipt IS NULL', [String(meta.MpesaReceiptNumber).trim(), p.id]); return; }
    if (!p || p.status !== 'pending') return; // unknown (our push has not saved its id yet: the status poll will settle it) or already done
    const oid = +p.order_id;
    if (code !== 0) {
      const st = code === 1032 ? 'cancelled' : ([1037, 1019].includes(code) ? 'timeout' : 'failed');
      await c.run("UPDATE mpesa_payments SET status=?,result_code=?,result_desc=?,callback_at=now() WHERE id=?", [st, code, mbSub(desc, 0, 200), p.id]); return;
    }
    let receipt = String(meta.MpesaReceiptNumber ?? '').trim(), paid = meta.Amount !== undefined && meta.Amount !== null ? Math.round(num(meta.Amount) * 100) / 100 : null;
    if (receipt === '') { receipt = null; if (paid === null) paid = Number(p.amount); } // success from the status query: Daraja does not send the code there; staff confirm in M-Pesa
    let dup = false;
    if (receipt !== null && (await c.val('SELECT 1 FROM mpesa_payments WHERE receipt=? AND id<>?', [receipt, p.id]))) { dup = true; desc = 'Duplicate M-Pesa code ' + receipt; receipt = null; } // the same code twice: never count one payment two times
    const ord = await c.one('SELECT status,total,user_id,paid_at IS NOT NULL AS paid FROM orders WHERE id=?', [oid]);
    const total = ord ? Number(ord.total) : 0, review = dup || !ord || ord.status === 'cancelled' || !!ord.paid || paid === null || paid + 0.005 < total;
    await c.run("UPDATE mpesa_payments SET status='success',result_code=0,result_desc=?,receipt=?,paid_amount=?,paid_phone=?,txn_date=?,needs_review=?,callback_at=now() WHERE id=?",
      [mbSub(desc, 0, 200), receipt, paid === null ? null : paid.toFixed(2), String(meta.PhoneNumber ?? ''), String(meta.TransactionDate ?? ''), review ? 1 : 0, p.id]);
    if (!review) await c.run('UPDATE orders SET paid_at=now(),paid_by=NULL,updated_at=now() WHERE id=? AND paid_at IS NULL', [oid]);
    after = { oid, receipt, paid, review, dup, ord, cu: ord && ord.user_id ? +ord.user_id : 0 };
  });
  if (!after) return;
  const { oid, receipt, paid, review, dup, ord, cu } = after, ref = receipt ? ` (M-Pesa ${receipt})` : '';
  if (review) {
    const why = !ord ? 'the order no longer exists' : ord.status === 'cancelled' ? 'the order was cancelled' : dup ? 'this M-Pesa code was already used' : ord.paid ? 'the order was already paid' : 'the amount received ' + nfMoney(c, paid) + ' is less than the order total';
    await nfAdd(c, 'staff', null, 'order_paid', 'M-Pesa payment needs review: order #' + oid, nfMoney(c, paid) + ref + ' received but ' + why + '. Check it in M-Pesa and refund or apply it by hand.', 'tab:o');
    return;
  }
  if (cu) await nfAdd(c, '', cu, 'mine_paid', 'Payment received for order #' + oid + '. Thank you!', 'M-Pesa' + (receipt ? ' code ' + receipt : '') + '. Your order will be dispatched shortly.', 'orders');
  await nfAdd(c, 'staff', null, 'order_paid', 'M-Pesa payment received for order #' + oid, nfMoney(c, paid) + ref, 'tab:o');
}

export const routes = {
  // POST {order_id, phone?}
  async m_pay(c) {
    post(c); ready(c);
    const id = int(c.in.order_id), o = await myOrder(c, id);
    if (o.paid) out({ error: 'This order is already paid.' }, 409);
    if (!['pending', 'confirmed'].includes(o.status)) out({ error: 'This order can no longer be paid online.' }, 409);
    const phone = mpesaPhone(str(c, 'phone') !== '' ? str(c, 'phone') : String(o.phone));
    if (phone === '') out({ error: 'Enter the Safaricom number that will pay, like 0712345678.' }, 422);
    const amount = mpesaAmount(o.total); if (amount < 1) out({ error: 'This order has nothing to pay.' }, 422);
    let pid = 0, early = null;
    await c.tx(async () => {
      const last = await c.one(`SELECT id,status,phone,${AGE}<${PENDING_SECS} AS live FROM mpesa_payments WHERE order_id=? ORDER BY id DESC LIMIT 1`, [id]);
      if (last && last.status === 'pending' && last.live) { early = { ok: true, order_id: id, already_sent: true, phone: mask(last.phone), message: 'A payment request was just sent. Check your phone and enter your M-Pesa PIN.' }; return; }
      if (+(await c.val("SELECT COUNT(*) FROM mpesa_payments WHERE order_id=? AND created_at>now()-interval '15 minutes'", [id])) >= 5) out({ error: 'Too many payment attempts. Wait a few minutes and try again.' }, 429);
      await c.run('INSERT INTO mpesa_payments(order_id,user_id,phone,amount) VALUES(?,?,?,?)', [id, await uid(c), phone, amount]);
      pid = +(await c.val('SELECT last_insert_rowid()'));
    });
    if (early) out(early);
    let r;
    try { r = await stkPush(c, phone, amount, 'Order ' + id, 'Order ' + id); }
    catch (x) {
      await c.run("UPDATE mpesa_payments SET status='failed',result_desc=? WHERE id=?", [mbSub(x.message, 0, 200), pid]);
      await finishNow(c); out({ error: 'We could not send the M-Pesa request: ' + x.message }, 502);
    }
    await c.run('UPDATE mpesa_payments SET checkout_request_id=?,merchant_request_id=? WHERE id=?', [String(r.CheckoutRequestID), String(r.MerchantRequestID ?? ''), pid]);
    out({ ok: true, order_id: id, phone: mask(phone), amount, message: 'Check your phone and enter your M-Pesa PIN to pay.' });
  },

  // ?order_id= polled by the page every few seconds
  async m_status(c) {
    const id = int(c.get('order_id') || c.in.order_id), o = await myOrder(c, id);
    if (o.paid) out({ state: 'success', message: 'Payment received. Thank you!', receipt: String((await c.val("SELECT receipt FROM mpesa_payments WHERE order_id=? AND status='success' ORDER BY id DESC LIMIT 1", [id])) ?? '') });
    const sel = `SELECT id,status,result_code,result_desc,checkout_request_id,${AGE} AS age FROM mpesa_payments WHERE order_id=? ORDER BY id DESC LIMIT 1`;
    let p = await c.one(sel, [id]); if (!p) out({ state: 'none' });
    // Callback late or lost: after ~15 s ask Safaricom directly. Only a real answer from Daraja is trusted; "still processing" leaves it pending.
    if (p.status === 'pending' && p.checkout_request_id && +p.age >= 15 && mpesaReady(c)) {
      try { const q = await stkQuery(p.checkout_request_id); if (q.code !== null) await settle(c, p.checkout_request_id, q.code, q.desc, {}); }
      catch (x) { console.error('M-Pesa query:', x.message); }
      p = await c.one(sel, [id]);
    }
    if (p.status === 'pending' && +p.age > 240) { await c.run("UPDATE mpesa_payments SET status='timeout',result_desc='No answer from the customer or Safaricom' WHERE id=? AND status='pending'", [p.id]); p.status = 'timeout'; p.result_code = 1037; }
    if (p.status === 'success') out({ state: 'success', message: 'Payment received. Thank you!' }); // paid but the order could not take it: staff were alerted
    if (p.status === 'pending') out({ state: 'pending', message: 'Waiting for you to enter your M-Pesa PIN…' });
    out({ state: 'failed', message: failText(p.result_code === null ? null : +p.result_code, String(p.result_desc ?? '')) });
  },

  // POST from Safaricom, no login. The secret in the address proves the request is meant for us.
  async m_callback(c) {
    const k = K(), given = Buffer.from(String(c.get('k'))), want = Buffer.from(k.cbSecret);
    if (!mpesaReady(c) || given.length !== want.length || !crypto.timingSafeEqual(given, want)) out({ ResultCode: 1, ResultDesc: 'Rejected' }, 403);
    if (c.method !== 'POST') out({ ResultCode: 1, ResultDesc: 'POST required' }, 405);
    const cb = c.in?.Body?.stkCallback;
    if (!cb || typeof cb !== 'object' || !cb.CheckoutRequestID || cb.ResultCode === undefined || cb.ResultCode === null) { console.error('M-Pesa callback: unexpected body'); out({ ResultCode: 0, ResultDesc: 'Ignored' }); }
    const meta = {}; for (const it of (cb.CallbackMetadata?.Item || [])) if (it && typeof it === 'object' && it.Name !== undefined) meta[String(it.Name)] = it.Value ?? null;
    try { await settle(c, String(cb.CheckoutRequestID), int(cb.ResultCode), String(cb.ResultDesc ?? ''), meta); }
    catch (x) { console.error('M-Pesa callback failed:', x); out({ ResultCode: 1, ResultDesc: 'Error' }, 500); } // Safaricom may retry
    out({ ResultCode: 0, ResultDesc: 'Accepted' });
  },
};
// A failed prompt must be saved even though the request ends with an error response (out() skips nothing: finish() still saves). Kept as a no-op hook for clarity.
async function finishNow() {}
