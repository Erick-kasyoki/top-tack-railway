// Invoices, invoice payments and recurring invoices: port of app/invoice_lib.php + app/modules/invoices/InvoiceController.php.
import { out, post, str, int, num, mbSub, cfg, isEmail, validDate, todayStr, rnd, role, staff, admin, nfAdd, nfMoney } from '../core.mjs';
import { Bad, FREQ, PAY_METHODS, cents, moneyStr, nf, addDays, addFreq, nextNo } from '../helpers.mjs';

// An invoice with what has been paid and its status: draft, unpaid, partial, overdue, paid or void. "Today" is the shop's local day.
export const invSql = c => `SELECT x.*,CASE WHEN x.status<>'sent' THEN x.status WHEN x.paid>=x.total-0.004 THEN 'paid' WHEN x.due_date<'${todayStr(c)}' THEN 'overdue' WHEN x.paid>0 THEN 'partial' ELSE 'unpaid' END AS pstatus
 FROM (SELECT i.*,COALESCE((SELECT SUM(amount) FROM invoice_payments p WHERE p.invoice_id=i.id),0) AS paid FROM invoices i) x`;
const r2 = v => Math.round(Number(v) * 100) / 100;
export function invRow(r) {
  const f = k => r2(r[k]);
  return { id: +r.id, number: r.number, token: r.token, status: r.status, pstatus: r.pstatus, customer_name: r.customer_name, customer_email: r.customer_email, customer_phone: r.customer_phone, customer_address: r.customer_address,
    order_id: r.order_id === null ? null : +r.order_id, recurring_id: r.recurring_id === null ? null : +r.recurring_id, issue_date: r.issue_date, due_date: r.due_date,
    tax_rate: f('tax_rate'), discount: f('discount'), subtotal: f('subtotal'), tax: f('tax'), total: f('total'), paid: f('paid'), balance: r2(Number(r.total) - Number(r.paid)), notes: r.notes };
}
// Full invoice (with lines and payments) by a WHERE fragment on x, e.g. 'x.token=?'.
export async function invLoad(c, where, param) {
  const r = await c.one(invSql(c) + ' WHERE ' + where, [param]); if (!r) return null;
  const inv = invRow(r);
  inv.items = (await c.all('SELECT product_id,description,qty,unit_price FROM invoice_items WHERE invoice_id=? ORDER BY position,id', [inv.id]))
    .map(i => ({ product_id: i.product_id === null ? null : +i.product_id, description: i.description, qty: Number(i.qty), unit_price: Number(i.unit_price) }));
  inv.payments = (await c.all('SELECT id,amount,method,paid_on,note FROM invoice_payments WHERE invoice_id=? ORDER BY paid_on,id', [inv.id]))
    .map(p => ({ id: +p.id, amount: Number(p.amount), method: p.method, paid_on: p.paid_on, note: p.note }));
  return inv;
}
// Shared by invoices and quotations: validates the form lines and works out totals (in cents). Throws Bad with a readable message.
export function docClean(d, what, dateKeys) {
  const name = String(d.customer_name ?? '').trim(); if (name === '') throw new Bad('Enter the customer name.');
  const email = String(d.customer_email ?? '').trim(); if (email !== '' && !isEmail(email)) throw new Bad('That customer email doesn’t look right.');
  const [k1, k2] = dateKeys, a = String(d[k1] ?? ''), b = String(d[k2] ?? '');
  const tax = num(d.tax_rate ?? 0); if (tax < 0 || tax > 100) throw new Bad('Tax must be between 0 and 100%.');
  let disc = cents(d.discount ?? 0); if (disc < 0) throw new Bad('Discount can’t be negative.');
  const items = [];
  for (const it0 of (Array.isArray(d.items) ? d.items : [])) {
    const it = it0 && typeof it0 === 'object' ? it0 : {}, desc = String(it.description ?? '').trim(), q = num(it.qty ?? 0), p = num(it.unit_price ?? 0);
    if (desc === '' && q === 0 && p === 0) continue;
    if (desc === '' || q <= 0 || q > 1000000 || p < 0 || p > 100000000) throw new Bad('Each line needs a description, a quantity above 0 and a price of 0 or more.');
    items.push({ product_id: int(it.product_id) || null, description: mbSub(desc, 0, 200), qty: Math.round(q * 100) / 100, unit_price: Math.round(p * 100) / 100 });
  }
  if (!items.length) throw new Bad('Add at least one line item.');
  if (items.length > 100) throw new Bad(`${what} can have up to 100 lines.`);
  let sub = 0; for (const it of items) sub += cents(it.qty * it.unit_price);
  disc = Math.min(disc, sub); const net = sub - disc, taxc = Math.round(net * tax / 100);
  return { a, b, name, email, tax, disc, sub, taxc, net, items };
}
export function invClean(d) {
  const x = docClean(d, 'An invoice', ['issue_date', 'due_date']);
  if (!validDate(x.a) || !validDate(x.b)) throw new Bad('Enter a valid issue date and due date.');
  if (x.b < x.a) throw new Bad('The due date can’t be before the issue date.');
  return { customer_name: mbSub(x.name, 0, 120), customer_email: mbSub(x.email, 0, 120), customer_phone: mbSub(String(d.customer_phone ?? '').trim(), 0, 40), customer_address: mbSub(String(d.customer_address ?? '').trim(), 0, 300),
    issue_date: x.a, due_date: x.b, tax_rate: Math.round(x.tax * 100) / 100, discount: x.disc, subtotal: x.sub, tax: x.taxc, total: x.net + x.taxc, notes: mbSub(String(d.notes ?? '').trim(), 0, 1000), items: x.items };
}
export async function docItems(c, table, col, id, items) {
  let n = 0;
  for (const it of items) await c.run(`INSERT INTO ${table}(${col},product_id,description,qty,unit_price,position) VALUES(?,?,?,?,?,?)`, [id, it.product_id, it.description, it.qty, it.unit_price, n++]);
}
// Inserts an invoice from invClean() output. Call inside a transaction.
export async function invCreate(c, cl, status, orderId = null, recId = null) {
  const num_ = await nextNo(c, 'invoices', cfg(c, 'INVOICE_PREFIX', 'INV-')), tok = rnd(16);
  await c.run('INSERT INTO invoices(number,token,status,customer_name,customer_email,customer_phone,customer_address,order_id,recurring_id,issue_date,due_date,tax_rate,discount,subtotal,tax,total,notes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [num_, tok, status, cl.customer_name, cl.customer_email, cl.customer_phone, cl.customer_address, orderId, recId, cl.issue_date, cl.due_date, cl.tax_rate, moneyStr(cl.discount), moneyStr(cl.subtotal), moneyStr(cl.tax), moneyStr(cl.total), cl.notes]);
  const id = +(await c.val('SELECT last_insert_rowid()'));
  await docItems(c, 'invoice_items', 'invoice_id', id, cl.items);
  return { id, number: num_, token: tok };
}
// Creates every recurring invoice that is due (catching up on missed periods). Returns how many were made.
export async function runRecurring(c, max = 50) {
  let made = 0;
  while (made < max) {
    const more = await c.tx(async () => {
      const r = await c.one('SELECT * FROM recurring_invoices WHERE active=1 AND next_date<=? ORDER BY next_date,id LIMIT 1', [todayStr(c)]);
      if (!r) return false;
      try {
        let items = []; try { items = JSON.parse(r.items) || []; } catch (e) {}
        const cl = invClean({ customer_name: r.customer_name, customer_email: r.customer_email, customer_phone: r.customer_phone, customer_address: r.customer_address, issue_date: r.next_date, due_date: addDays(r.next_date, +r.due_days),
          tax_rate: r.tax_rate, discount: r.discount, notes: r.notes, items });
        await invCreate(c, cl, 'sent', null, +r.id); made++;
        await c.run('UPDATE recurring_invoices SET runs=runs+1,next_date=? WHERE id=?', [addFreq(r.start_date, r.frequency, +r.runs + 1), r.id]);
      } catch (x) {
        if (!(x instanceof Bad)) throw x;
        await c.run('UPDATE recurring_invoices SET active=0 WHERE id=?', [r.id]); // a broken template pauses itself
      }
      return true;
    });
    if (!more) break;
  }
  return made;
}

export const routes = {
  async a_invoices(c) {
    await staff(c); const adm = (await role(c)) === 'admin'; if (adm) await runRecurring(c);
    const r = (await c.all(invSql(c) + ' ORDER BY x.id DESC LIMIT 500')).map(invRow);
    const t = { outstanding: 0, overdue: 0, overdue_n: 0, drafts: 0 };
    for (const x of r) {
      if (x.pstatus === 'draft') t.drafts++;
      if (['unpaid', 'partial', 'overdue'].includes(x.pstatus)) t.outstanding += x.balance;
      if (x.pstatus === 'overdue') { t.overdue += x.balance; t.overdue_n++; }
    }
    t.outstanding = r2(t.outstanding); t.overdue = r2(t.overdue);
    t.collected_month = r2(await c.val("SELECT COALESCE(SUM(p.amount),0) FROM invoice_payments p JOIN invoices i ON i.id=p.invoice_id WHERE i.status<>'void' AND substr(p.paid_on,1,7)=?", [todayStr(c).slice(0, 7)]));
    const rec = [];
    if (adm) for (const q of await c.all('SELECT id,customer_name,items,tax_rate,discount,frequency,next_date,active FROM recurring_invoices ORDER BY id DESC')) {
      let items = []; try { items = JSON.parse(q.items) || []; } catch (e) {}
      let sub = 0; for (const it of items) sub += cents(it.qty * it.unit_price);
      const net = Math.max(0, sub - cents(q.discount));
      rec.push({ id: +q.id, customer_name: q.customer_name, frequency: q.frequency, next_date: q.next_date, active: !!q.active, amount: (net + Math.round(net * Number(q.tax_rate) / 100)) / 100 });
    }
    out({ totals: t, items: r, recurring: rec, methods: PAY_METHODS });
  },
  async a_invoice(c) { await staff(c); const v = await invLoad(c, 'x.id=?', int(c.get('id'))); if (!v) out({ error: 'Unknown invoice.' }, 404); out(v); },

  async a_inv_save(c) {
    post(c); await staff(c); const inp = c.in; let cl;
    try { cl = invClean(inp); } catch (x) { if (x instanceof Bad) out({ error: x.message }, 422); throw x; }
    const id = int(inp.id); let res;
    await c.tx(async () => {
      if (id) {
        const o = await c.one('SELECT status,(SELECT COALESCE(SUM(amount),0) FROM invoice_payments WHERE invoice_id=invoices.id) AS paid FROM invoices WHERE id=?', [id]);
        if (!o) out({ error: 'Unknown invoice.' }, 404);
        if (o.status === 'void') out({ error: 'Void invoices can’t be edited.' }, 409);
        if (cents(o.paid) > cl.total) out({ error: 'This invoice already has ' + nf(o.paid) + ' paid, which is more than the new total. Remove a payment first.' }, 409);
        await c.run('UPDATE invoices SET customer_name=?,customer_email=?,customer_phone=?,customer_address=?,issue_date=?,due_date=?,tax_rate=?,discount=?,subtotal=?,tax=?,total=?,notes=? WHERE id=?',
          [cl.customer_name, cl.customer_email, cl.customer_phone, cl.customer_address, cl.issue_date, cl.due_date, cl.tax_rate, moneyStr(cl.discount), moneyStr(cl.subtotal), moneyStr(cl.tax), moneyStr(cl.total), cl.notes, id]);
        await c.run('DELETE FROM invoice_items WHERE invoice_id=?', [id]); await docItems(c, 'invoice_items', 'invoice_id', id, cl.items);
        if (inp.send && o.status === 'draft') await c.run("UPDATE invoices SET status='sent' WHERE id=?", [id]);
        const n = await c.one('SELECT number,token FROM invoices WHERE id=?', [id]); res = { id, number: n.number, token: n.token };
      } else {
        let recId = null; const f = String(inp.repeat ?? '');
        if (f !== '' && (await role(c)) !== 'admin') out({ error: 'Only an admin can set up repeating invoices.' }, 403);
        if (f !== '') {
          if (!FREQ.includes(f)) out({ error: 'Choose how often to repeat.' }, 422);
          const days = Math.round((Date.parse(cl.due_date) - Date.parse(cl.issue_date)) / 86400000);
          await c.run('INSERT INTO recurring_invoices(customer_name,customer_email,customer_phone,customer_address,items,tax_rate,discount,notes,frequency,due_days,start_date,runs,next_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?)',
            [cl.customer_name, cl.customer_email, cl.customer_phone, cl.customer_address, JSON.stringify(cl.items), cl.tax_rate, moneyStr(cl.discount), cl.notes, f, days, cl.issue_date, addFreq(cl.issue_date, f, 1)]);
          recId = +(await c.val('SELECT last_insert_rowid()'));
        }
        res = await invCreate(c, cl, inp.send ? 'sent' : 'draft', null, recId);
      }
    });
    out({ ok: true, ...res });
  },

  async a_inv_status(c) {
    post(c); await staff(c); const id = int(c.in.id), st = str(c, 'status');
    if (!['draft', 'sent', 'void'].includes(st)) out({ error: 'Unknown status.' }, 422);
    await c.tx(async () => {
      const o = await c.one('SELECT status,(SELECT COUNT(*) FROM invoice_payments WHERE invoice_id=invoices.id) AS n FROM invoices WHERE id=?', [id]);
      if (!o) out({ error: 'Unknown invoice.' }, 404);
      if (o.status === 'void') out({ error: 'Void invoices can’t be reopened.' }, 409);
      if (st === 'draft' && +o.n > 0) out({ error: 'This invoice has payments, so it can’t go back to draft.' }, 409);
      await c.run('UPDATE invoices SET status=? WHERE id=?', [st, id]);
    });
    out({ ok: true });
  },
  async a_inv_delete(c) {
    post(c); await staff(c);
    if (await c.exec("DELETE FROM invoices WHERE id=? AND status='draft'", [int(c.in.id)]) !== 1) out({ error: 'Only drafts can be deleted. Void the invoice instead.' }, 409);
    out({ ok: true });
  },
  async a_inv_pay(c) {
    post(c); await staff(c); const id = int(c.in.id), amt = cents(c.in.amount ?? 0), method = str(c, 'method'), on = str(c, 'paid_on');
    if (amt <= 0) out({ error: 'Enter the amount received.' }, 422);
    if (!PAY_METHODS.includes(method)) out({ error: 'Choose a payment method.' }, 422);
    if (on !== '' && !validDate(on)) out({ error: 'Enter a valid payment date.' }, 422);
    await c.tx(async () => {
      const o = await c.one('SELECT status,total,(SELECT COALESCE(SUM(amount),0) FROM invoice_payments WHERE invoice_id=invoices.id) AS paid FROM invoices WHERE id=?', [id]);
      if (!o) out({ error: 'Unknown invoice.' }, 404);
      if (o.status !== 'sent') out({ error: o.status === 'draft' ? 'Mark the invoice as sent before recording a payment.' : 'Void invoices can’t take payments.' }, 409);
      const bal = cents(o.total) - cents(o.paid);
      if (amt > bal) out({ error: 'The balance due is ' + nf(bal / 100) + ', so you can’t record more than that.' }, 409);
      await c.run('INSERT INTO invoice_payments(invoice_id,amount,method,paid_on,note) VALUES(?,?,?,?,?)', [id, moneyStr(amt), method, on || todayStr(c), mbSub(str(c, 'note'), 0, 200)]);
    });
    await nfAdd(c, 'staff', null, 'invoice_paid', 'Payment recorded on ' + await c.val('SELECT number FROM invoices WHERE id=?', [id]), nfMoney(c, amt / 100) + ' · ' + method, 'tab:v');
    out({ ok: true });
  },
  async a_inv_unpay(c) {
    post(c); await admin(c);
    if (await c.exec('DELETE FROM invoice_payments WHERE id=?', [int(c.in.id)]) !== 1) out({ error: 'Unknown payment.' }, 404);
    out({ ok: true });
  },
  async a_inv_from_order(c) {
    post(c); await staff(c); const oid = int(c.in.order_id);
    const ex = await c.val('SELECT id FROM invoices WHERE order_id=? ORDER BY id LIMIT 1', [oid]); if (ex) out({ id: +ex, existing: true });
    const o = await c.one('SELECT o.*,u.email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.id=?', [oid]);
    if (!o) out({ error: 'Unknown order.' }, 404);
    if (o.status === 'cancelled') out({ error: 'This order was cancelled.' }, 409);
    const items = await c.all('SELECT product_id,name AS description,qty,unit_price FROM order_items WHERE order_id=? ORDER BY id', [oid]), today = todayStr(c);
    let cl; // order prices already include everything the customer paid, so no extra tax is added here
    try { cl = invClean({ customer_name: o.name, customer_email: o.email, customer_phone: o.phone, customer_address: o.address, issue_date: today, due_date: addDays(today, int(cfg(c, 'DUE_DAYS', 14))), tax_rate: 0, discount: 0, notes: 'Order #' + oid + ' (' + o.payment + ')', items }); }
    catch (x) { if (x instanceof Bad) out({ error: x.message }, 422); throw x; }
    const r = await c.tx(() => invCreate(c, cl, 'draft', oid));
    out({ id: r.id, existing: false });
  },
  async a_rec_toggle(c) {
    post(c); await admin(c); const id = int(c.in.id);
    if (!c.in.active) { await c.run('UPDATE recurring_invoices SET active=0 WHERE id=?', [id]); out({ ok: true }); }
    // Resuming skips the periods missed while paused, so it doesn't suddenly create a pile of old invoices.
    const r = await c.one('SELECT frequency,start_date,runs FROM recurring_invoices WHERE id=?', [id]); if (!r) out({ error: 'Unknown repeating invoice.' }, 404);
    const today = todayStr(c); let n = +r.runs, found = false;
    for (let k = +r.runs; k <= +r.runs + 2000; k++) if (addFreq(r.start_date, r.frequency, k) >= today) { n = k; found = true; break; }
    await c.run('UPDATE recurring_invoices SET active=1,runs=?,next_date=? WHERE id=?', [found ? n : +r.runs, addFreq(r.start_date, r.frequency, found ? n : +r.runs), id]);
    out({ ok: true });
  },
  async a_rec_delete(c) { post(c); await admin(c); await c.run('DELETE FROM recurring_invoices WHERE id=?', [int(c.in.id)]); out({ ok: true }); },
};
