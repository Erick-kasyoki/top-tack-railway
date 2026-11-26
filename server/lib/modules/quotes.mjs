// Quotations: port of app/quotes_lib.php. Staff create, send and track them; customers view, accept or decline with a private link,
// and ask for one from the store (they arrive as status "request").
import { out, post, str, int, mbSub, cfg, validDate, todayStr, rnd, uid, staff, nfAdd, throttle, failTry } from '../core.mjs';
import { Bad, cents, moneyStr, addDays, nextNo, mhMail, adminMail } from '../helpers.mjs';
import { docClean, docItems, invClean, invCreate } from './invoices.mjs';

const DEFAULT_TERMS = 'Prices are in the currency shown and valid until the date above.\nPayment: cash on delivery or on pickup unless agreed otherwise.\nDelivery time is confirmed when you accept this quotation.';
const qtSql = c => `SELECT q.*,CASE WHEN q.status='sent' AND q.valid_until<'${todayStr(c)}' THEN 'expired' ELSE q.status END AS qstatus,i.number AS invoice_number FROM quotations q LEFT JOIN invoices i ON i.id=q.invoice_id`;
const r2 = v => Math.round(Number(v) * 100) / 100;
export function qtRow(r) {
  const f = k => r2(r[k]);
  return { id: +r.id, number: r.number, token: r.token, status: r.status, qstatus: r.qstatus, customer_name: r.customer_name, customer_company: r.customer_company, customer_email: r.customer_email, customer_phone: r.customer_phone, customer_address: r.customer_address,
    subject: r.subject, issue_date: r.issue_date, valid_until: r.valid_until, tax_rate: f('tax_rate'), discount: f('discount'), subtotal: f('subtotal'), tax: f('tax'), total: f('total'),
    notes: r.notes, terms: r.terms, request_text: r.request_text, invoice_id: r.invoice_id === null ? null : +r.invoice_id, invoice_number: r.invoice_number, created_at: r.created_at };
}
export async function qtLoad(c, where, param) {
  const r = await c.one(qtSql(c) + ' WHERE ' + where, [param]); if (!r) return null;
  const q = qtRow(r);
  q.items = (await c.all('SELECT product_id,description,qty,unit_price FROM quotation_items WHERE quotation_id=? ORDER BY position,id', [q.id]))
    .map(i => ({ product_id: i.product_id === null ? null : +i.product_id, description: i.description, qty: Number(i.qty), unit_price: Number(i.unit_price) }));
  return q;
}
function qtClean(d) {
  const x = docClean(d, 'A quotation', ['issue_date', 'valid_until']);
  if (!validDate(x.a) || !validDate(x.b)) throw new Bad('Enter a valid quotation date and “valid until” date.');
  if (x.b < x.a) throw new Bad('“Valid until” can’t be before the quotation date.');
  const t = k => String(d[k] ?? '').trim();
  return { customer_name: mbSub(x.name, 0, 120), customer_company: mbSub(t('customer_company'), 0, 120), customer_email: mbSub(x.email, 0, 120), customer_phone: mbSub(t('customer_phone'), 0, 40), customer_address: mbSub(t('customer_address'), 0, 300),
    subject: mbSub(t('subject'), 0, 160), issue_date: x.a, valid_until: x.b, tax_rate: Math.round(x.tax * 100) / 100, discount: x.disc, subtotal: x.sub, tax: x.taxc, total: x.net + x.taxc,
    notes: mbSub(t('notes'), 0, 1000), terms: mbSub(t('terms'), 0, 1500), items: x.items };
}
const qtNumber = c => nextNo(c, 'quotations', cfg(c, 'QUOTE_PREFIX', 'QUO-'));
async function qtCreate(c, cl, status, by) {
  const number = await qtNumber(c), tok = rnd(16);
  await c.run('INSERT INTO quotations(number,token,status,customer_name,customer_company,customer_email,customer_phone,customer_address,subject,issue_date,valid_until,tax_rate,discount,subtotal,tax,total,notes,terms,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [number, tok, status, cl.customer_name, cl.customer_company, cl.customer_email, cl.customer_phone, cl.customer_address, cl.subject, cl.issue_date, cl.valid_until, cl.tax_rate, moneyStr(cl.discount), moneyStr(cl.subtotal), moneyStr(cl.tax), moneyStr(cl.total), cl.notes, cl.terms, by]);
  const id = +(await c.val('SELECT last_insert_rowid()'));
  await docItems(c, 'quotation_items', 'quotation_id', id, cl.items);
  return { id, number, token: tok };
}
export const qtTerms = c => { const t = String(cfg(c, 'QUOTE_TERMS', '')).trim(); return t !== '' ? t : DEFAULT_TERMS; };
const bad = x => { if (x instanceof Bad) out({ error: x.message }, 422); throw x; };

export const routes = {
  async q_list(c) {
    await staff(c);
    const r = (await c.all(qtSql(c) + ' ORDER BY q.id DESC LIMIT 500')).map(qtRow), month = todayStr(c).slice(0, 7);
    const t = { requests: 0, drafts: 0, open_n: 0, open_value: 0, won_month: 0, won_n: 0 };
    for (const x of r) {
      if (x.qstatus === 'request') t.requests++;
      if (x.qstatus === 'draft') t.drafts++;
      if (x.qstatus === 'sent') { t.open_n++; t.open_value += x.total; }
      if (x.status === 'accepted' && String(x.created_at).slice(0, 7) === month) { t.won_month += x.total; t.won_n++; }
    }
    t.open_value = r2(t.open_value); t.won_month = r2(t.won_month);
    out({ totals: t, items: r, defaults: { valid_days: int(cfg(c, 'QUOTE_VALID_DAYS', 30)), terms: qtTerms(c) } });
  },
  async q_count(c) { await staff(c); out({ requests: +(await c.val("SELECT COUNT(*) FROM quotations WHERE status='request'")) }); },
  async q_get(c) { await staff(c); const q = await qtLoad(c, 'q.id=?', int(c.get('id'))); if (!q) out({ error: 'Unknown quotation.' }, 404); out(q); },

  async q_save(c) {
    post(c); await staff(c); const inp = c.in; let cl;
    try { cl = qtClean(inp); } catch (x) { bad(x); }
    const id = int(inp.id); let res;
    await c.tx(async () => {
      if (id) {
        const o = await c.one('SELECT status,invoice_id FROM quotations WHERE id=?', [id]);
        if (!o) out({ error: 'Unknown quotation.' }, 404);
        if (o.invoice_id !== null || ['void', 'accepted'].includes(o.status)) out({ error: 'This quotation is ' + (o.invoice_id !== null ? 'already an invoice' : o.status) + ' and can’t be edited. Duplicate it to make a new version.' }, 409);
        await c.run('UPDATE quotations SET customer_name=?,customer_company=?,customer_email=?,customer_phone=?,customer_address=?,subject=?,issue_date=?,valid_until=?,tax_rate=?,discount=?,subtotal=?,tax=?,total=?,notes=?,terms=?,updated_at=now() WHERE id=?',
          [cl.customer_name, cl.customer_company, cl.customer_email, cl.customer_phone, cl.customer_address, cl.subject, cl.issue_date, cl.valid_until, cl.tax_rate, moneyStr(cl.discount), moneyStr(cl.subtotal), moneyStr(cl.tax), moneyStr(cl.total), cl.notes, cl.terms, id]);
        await c.run('DELETE FROM quotation_items WHERE quotation_id=?', [id]); await docItems(c, 'quotation_items', 'quotation_id', id, cl.items);
        // a customer's website request becomes a draft once priced; "send" marks any editable quotation as sent
        if (inp.send) await c.run("UPDATE quotations SET status='sent' WHERE id=?", [id]);
        else if (o.status === 'request') await c.run("UPDATE quotations SET status='draft' WHERE id=?", [id]);
        const n = await c.one('SELECT number,token FROM quotations WHERE id=?', [id]); res = { id, number: n.number, token: n.token };
      } else res = await qtCreate(c, cl, inp.send ? 'sent' : 'draft', await uid(c));
    });
    out({ ok: true, ...res });
  },
  async q_status(c) {
    post(c); await staff(c); const id = int(c.in.id), st = str(c, 'status');
    if (!['draft', 'sent', 'accepted', 'declined', 'void'].includes(st)) out({ error: 'Unknown status.' }, 422);
    await c.tx(async () => {
      const o = await c.one('SELECT status,invoice_id,total FROM quotations WHERE id=?', [id]);
      if (!o) out({ error: 'Unknown quotation.' }, 404);
      if (o.status === 'void') out({ error: 'Void quotations can’t be reopened.' }, 409);
      if (o.invoice_id !== null && st !== 'void') out({ error: 'This quotation was already turned into an invoice.' }, 409);
      if (o.status === 'request' && ['sent', 'accepted'].includes(st) && Number(o.total) <= 0) out({ error: 'Price this request first (Edit), then send it.' }, 409);
      await c.run(`UPDATE quotations SET status=?,updated_at=now(),responded_at=${['accepted', 'declined'].includes(st) ? 'now()' : 'NULL'} WHERE id=?`, [st, id]);
    });
    out({ ok: true });
  },
  async q_delete(c) {
    post(c); await staff(c);
    if (await c.exec("DELETE FROM quotations WHERE id=? AND status IN('draft','request','void')", [int(c.in.id)]) !== 1) out({ error: 'Only drafts, requests and void quotations can be deleted. Void it instead.' }, 409);
    out({ ok: true });
  },
  async q_duplicate(c) {
    post(c); await staff(c);
    const q = await qtLoad(c, 'q.id=?', int(c.in.id)); if (!q) out({ error: 'Unknown quotation.' }, 404);
    const t = todayStr(c); let cl;
    try { cl = qtClean({ ...q, issue_date: t, valid_until: addDays(t, int(cfg(c, 'QUOTE_VALID_DAYS', 30))) }); } catch (x) { if (x instanceof Bad) out({ error: 'This quotation has no priced lines to copy. Edit it instead.' }, 409); throw x; }
    const r = await c.tx(async () => qtCreate(c, cl, 'draft', await uid(c)));
    out({ ok: true, ...r });
  },
  // Turns a quotation into a DRAFT invoice (same customer, lines, discount and tax) and marks the quotation accepted.
  async q_to_invoice(c) {
    post(c); await staff(c); let res;
    await c.tx(async () => {
      const q = await c.one('SELECT * FROM quotations WHERE id=?', [int(c.in.id)]);
      if (!q) out({ error: 'Unknown quotation.' }, 404);
      if (q.invoice_id !== null) out({ id: +q.invoice_id, existing: true });
      if (['void', 'declined', 'request'].includes(q.status)) out({ error: 'A ' + q.status + ' quotation can’t be turned into an invoice.' }, 409);
      const items = await c.all('SELECT product_id,description,qty,unit_price FROM quotation_items WHERE quotation_id=? ORDER BY position,id', [q.id]), t = todayStr(c);
      let cl;
      try { cl = invClean({ customer_name: q.customer_name, customer_email: q.customer_email, customer_phone: q.customer_phone, customer_address: q.customer_address, issue_date: t, due_date: addDays(t, int(cfg(c, 'DUE_DAYS', 14))), tax_rate: q.tax_rate, discount: q.discount, notes: 'From quotation ' + q.number, items }); } catch (x) { bad(x); }
      const r = await invCreate(c, cl, 'draft', null, null);
      await c.run("UPDATE quotations SET invoice_id=?,status='accepted',updated_at=now(),responded_at=COALESCE(responded_at,now()) WHERE id=?", [r.id, q.id]);
      res = { id: r.id, q };
    });
    await nfAdd(c, 'staff', null, 'quote_invoice', 'Invoice created from quotation ' + res.q.number, res.q.customer_name, 'tab:v');
    out({ id: res.id, existing: false });
  },
  // PUBLIC: a customer asks for a quotation from the store. Limited per address; a hidden field catches simple bots.
  async q_request(c) {
    post(c); const inp = c.in;
    if (String(inp.website ?? '').trim() !== '') out({ ok: true });
    const k = 'quote:' + c.ip; await throttle(c, k, 5);
    const who = str(c, 'who'), ph = str(c, 'phone'), em = str(c, 'email'), need = str(c, 'need');
    if (who === '' || ph.length < 7 || need === '') out({ error: 'Enter your name, phone number and what you need.' }, 422);
    if (em !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) out({ error: 'That email doesn’t look right.' }, 422);
    await failTry(c, k);
    const t = todayStr(c); let number;
    await c.tx(async () => {
      number = await qtNumber(c);
      await c.run("INSERT INTO quotations(number,token,status,customer_name,customer_email,customer_phone,issue_date,valid_until,request_text) VALUES(?,?,'request',?,?,?,?,?,?)",
        [number, rnd(16), mbSub(who, 0, 120), mbSub(em, 0, 120), mbSub(ph, 0, 40), t, addDays(t, int(cfg(c, 'QUOTE_VALID_DAYS', 30))), mbSub(need, 0, 2000)]);
    });
    await nfAdd(c, 'staff', null, 'quote_new', 'New quotation request ' + number, who + ' · ' + ph, 'tab:q');
    mhMail(c, adminMail(c), 'New quotation request ' + number + ' from ' + who, `Name: ${who}\r\nPhone: ${ph}\r\nEmail: ${em}\r\n\r\n${need}\r\n`);
    out({ ok: true, number });
  },
  // PUBLIC: the customer accepts or declines from the private link.
  async q_respond(c) {
    post(c); const k = 'quote-r:' + c.ip; await throttle(c, k, 20); await failTry(c, k);
    const tok = str(c, 'token'), d = str(c, 'decision');
    if (!/^[a-f0-9]{32}$/.test(tok) || !['accepted', 'declined'].includes(d)) out({ error: 'Invalid request.' }, 422);
    let q;
    await c.tx(async () => {
      q = await c.one('SELECT id,number,customer_name,status,valid_until FROM quotations WHERE token=?', [tok]);
      if (!q) out({ error: 'Quotation not found.' }, 404);
      if (q.status !== 'sent') out({ error: 'This quotation can no longer be answered online. Please contact us.' }, 409);
      if (q.valid_until < todayStr(c)) out({ error: 'This quotation has expired. Please contact us for a new one.' }, 409);
      await c.run('UPDATE quotations SET status=?,responded_at=now(),updated_at=now() WHERE id=?', [d, q.id]);
    });
    await nfAdd(c, 'staff', null, 'quote_reply', 'Quotation ' + q.number + ' ' + d, q.customer_name + ' answered online', 'tab:q');
    mhMail(c, adminMail(c), 'Quotation ' + q.number + ' ' + d + ' by ' + q.customer_name, 'Quotation ' + q.number + ' was ' + d + ' online by the customer.\r\n');
    out({ ok: true, status: d });
  },
};
