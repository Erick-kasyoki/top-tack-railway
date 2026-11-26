// Sales Management (POS): port of app/modules/sales/SalesController.php.
// Every sale, payment, return and cancellation runs in one transaction together with the stock change and is logged in sale_audit.
// Completed sales are never deleted. Workers see only their own sales; returns, cancellations and overselling are admin-only.
import { out, rawOut, post, str, int, num, mbSub, cfg, cx, csvCell, uid, role, admin, staff, mv, validDate, todayStr } from '../core.mjs';

const METHODS = ['M-Pesa', 'Cash', 'Bank transfer', 'Card'];
const cents = v => Math.round(num(v) * 100);
const dmoney = c => (c / 100).toFixed(2);
const N = v => Number(v) || 0;                       // booleans from the 0/1 fix-up still become 0/1 numbers
const esc = s => String(s).replace(/[\\%_]/g, m => '\\' + m);
const prefix = c => String(cfg(c, 'SALE_PREFIX', 'RCT-')).replace(/[^A-Za-z0-9-]/g, '') || 'RCT-';
const store = c => ({ name: cfg(c, 'SITE_NAME', ''), phone: cfg(c, 'SITE_PHONE', ''), phone2: cfg(c, 'SITE_PHONE2', ''), email: cfg(c, 'SITE_EMAIL', ''),
  address: cfg(c, 'SITE_ADDRESS', ''), logo: cfg(c, 'LOGO', 'img/logo.png'), currency: cfg(c, 'CURRENCY', 'KSh'), color: cfg(c, 'BRAND_COLOR', '#ED152A'), tax_name: cfg(c, 'TAX_NAME', 'VAT') });
const own = async c => (await role(c)) !== 'admin';

function row(r) {
  const f = k => Math.round(N(r[k]) * 100) / 100;
  const total = f('total'), ret = f('returned'), paid = f('paid'), due = Math.round((total - ret) * 100) / 100, bal = Math.round((due - paid) * 100) / 100;
  const ps = r.status === 'cancelled' ? 'cancelled' : (bal <= 0.004 ? 'paid' : (paid > 0.004 ? 'partial' : 'unpaid'));
  return { id: +r.id, receipt_no: r.receipt_no, status: r.status, customer_name: r.customer_name, customer_phone: r.customer_phone,
    subtotal: f('subtotal'), discount: f('discount'), tax_rate: f('tax_rate'), tax: f('tax'), total, returned: ret, net: due, paid,
    balance: r.status === 'cancelled' ? 0 : bal, pstatus: ps, method: r.method, note: r.note, oversold: !!r.oversold, cancel_reason: r.cancel_reason,
    at: r.at, cashier: r.cashier ?? '', cashier_id: r.cashier_id === null || r.cashier_id === undefined ? null : +r.cashier_id, units: r.units === undefined || r.units === null ? null : +r.units };
}
const SEL = `SELECT s.id,s.receipt_no,s.status,s.customer_name,s.customer_phone,s.subtotal,s.discount,s.tax_rate,s.tax,s.total,s.returned,s.paid,s.method,s.note,s.oversold,s.cancel_reason,s.cashier_id,
  to_char(s.created_at,'YYYY-MM-DD HH24:MI') AS at,u.name AS cashier,(SELECT COALESCE(SUM(qty),0) FROM sale_items i WHERE i.sale_id=s.id) AS units
  FROM sales s LEFT JOIN users u ON u.id=s.cashier_id`;
const audit = (c, sid, action, detail = '') => c.run('INSERT INTO sale_audit(sale_id,user_id,action,detail) VALUES(?,?,?,?)', [sid, null, action, mbSub(detail, 0, 500)]).then(() => 0);

// Shared filters for history, reports and exports. Workers are always limited to their own sales. Dates are shop-local days.
async function filters(c, o) {
  let w = 'WHERE 1=1'; const p = [];
  if (await own(c)) { w += ' AND s.cashier_id=?'; p.push(await uid(c)); }
  else if (int(o.cashier) > 0) { w += ' AND s.cashier_id=?'; p.push(int(o.cashier)); }
  const from = o.from || '', to = o.to || '';
  if (from !== '') { if (!validDate(from)) out({ error: 'Enter a valid start date.' }, 422); w += " AND to_char(s.created_at,'YYYY-MM-DD')>=?"; p.push(from); }
  if (to !== '') { if (!validDate(to)) out({ error: 'Enter a valid end date.' }, 422); w += " AND to_char(s.created_at,'YYYY-MM-DD')<=?"; p.push(to); }
  if (o.method) { w += ' AND s.method=?'; p.push(o.method); }
  if (int(o.product) > 0) { w += ' AND EXISTS(SELECT 1 FROM sale_items i WHERE i.sale_id=s.id AND i.product_id=?)'; p.push(int(o.product)); }
  const q = String(o.q || '').trim();
  if (q !== '') { const l = '%' + esc(q) + '%'; w += ' AND (s.receipt_no ILIKE ? OR s.customer_name ILIKE ? OR s.customer_phone ILIKE ? OR EXISTS(SELECT 1 FROM sale_items i WHERE i.sale_id=s.id AND (i.name ILIKE ? OR i.sku ILIKE ?)))'; p.push(l, l, l, l, l); }
  const st = o.status || '';
  if (['cancelled', 'completed', 'returned'].includes(st)) { w += ' AND s.status=?'; p.push(st); }
  else if (st === 'unpaid') w += " AND s.status<>'cancelled' AND s.paid<=0 AND s.total-s.returned>0";
  else if (st === 'partial') w += " AND s.status<>'cancelled' AND s.paid>0 AND s.total-s.returned-s.paid>0.004";
  else if (st === 'paid') w += " AND s.status<>'cancelled' AND s.total-s.returned-s.paid<=0.004";
  return [w, p];
}
const query = c => Object.fromEntries(c.url.searchParams.entries());

async function load(c, id) {
  const r = await c.one(SEL + ' WHERE s.id=?', [id]);
  if (!r) return null;
  if ((await own(c)) && +r.cashier_id !== (await uid(c))) return null;
  return row(r);
}
async function full(c, sale) {
  const id = sale.id;
  sale.items = (await c.all('SELECT id,product_id,name,sku,unit_price,qty,discount,net,returned_qty FROM sale_items WHERE sale_id=? ORDER BY id', [id]))
    .map(r => ({ ...r, id: +r.id, product_id: r.product_id === null ? null : +r.product_id, unit_price: N(r.unit_price), qty: +r.qty, discount: N(r.discount), net: N(r.net), returned_qty: +r.returned_qty }));
  sale.payments = (await c.all(`SELECT p.id,p.amount,p.method,p.reference,to_char(p.created_at,'YYYY-MM-DD HH24:MI') AS at,u.name AS "by" FROM sale_payments p LEFT JOIN users u ON u.id=p.user_id WHERE p.sale_id=? ORDER BY p.id`, [id]))
    .map(r => ({ ...r, id: +r.id, amount: N(r.amount) }));
  const rets = await c.all(`SELECT r.id,r.value,r.refund,r.refund_method,r.restock,r.cancel,r.reason,to_char(r.created_at,'YYYY-MM-DD HH24:MI') AS at,u.name AS "by" FROM sale_returns r LEFT JOIN users u ON u.id=r.user_id WHERE r.sale_id=? ORDER BY r.id`, [id]);
  const ri = await c.all('SELECT ri.return_id,i.name,ri.qty FROM sale_return_items ri JOIN sale_items i ON i.id=ri.sale_item_id JOIN sale_returns r ON r.id=ri.return_id WHERE r.sale_id=? ORDER BY ri.id', [id]);
  sale.returns = rets.map(r => ({ ...r, id: +r.id, value: N(r.value), refund: N(r.refund), restock: !!r.restock, cancel: !!r.cancel, items: ri.filter(x => +x.return_id === +r.id).map(x => `${x.name} ×${x.qty}`).join(', ') || null }));
  sale.audit = await c.all(`SELECT a.action,a.detail,to_char(a.created_at,'YYYY-MM-DD HH24:MI:SS') AS at,u.name AS "by" FROM sale_audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.sale_id=? ORDER BY a.id`, [id]);
  sale.store = store(c);
  return sale;
}

export const routes = {
  // product search for the sales screen: name, SKU or scanned barcode
  async s_products(c) {
    await staff(c);
    const q = c.get('q').trim(), l = '%' + esc(q) + '%';
    const r = await c.all(`SELECT id,name,sku,dept,emoji,image,price,stock,reorder_level FROM products
      WHERE (?='' OR name ILIKE ? OR sku ILIKE ? OR dept ILIKE ?) ORDER BY (lower(sku)=lower(?) AND ?<>'') DESC,(stock>0) DESC,name LIMIT 40`, [q, l, l, l, q, q]);
    out({ items: r.map(p => ({ ...p, id: +p.id, price: N(p.price), stock: +p.stock, reorder_level: +p.reorder_level })),
      tax_rate: num(cfg(c, 'DEFAULT_TAX', 0)), tax_name: cfg(c, 'TAX_NAME', 'VAT'), methods: METHODS, can_oversell: (await role(c)) === 'admin' });
  },

  // complete a sale: validates, records the sale, takes the payment and deducts stock in ONE transaction
  async s_create(c) {
    post(c); await staff(c);
    const I = c.in, key = str(c, 'key'), me = await uid(c), isAdmin = (await role(c)) === 'admin';
    if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) out({ error: 'Missing sale key. Reload the page and try again.' }, 422);
    const dup = await c.one('SELECT id,cashier_id FROM sales WHERE idem_key=?', [key]);
    if (dup) { if (+dup.cashier_id !== me && !isAdmin) out({ error: 'This sale key is already used.' }, 409); out({ id: +dup.id, duplicate: true }); }
    const lines = {};
    for (const it of Array.isArray(I.items) ? I.items : []) {
      const pid = int(it?.product_id), q = it?.qty;
      if (pid < 1 || q === null || q === undefined || q === '' || !Number.isFinite(+q) || !Number.isInteger(+q) || +q < 1 || +q > 100000) out({ error: 'Each item needs a product and a whole quantity of 1 or more.' }, 422);
      const dc = cents(it.discount ?? 0); if (dc < 0) out({ error: 'A discount cannot be negative.' }, 422);
      if (lines[pid]) { lines[pid].qty += +q; lines[pid].disc += dc; } else lines[pid] = { qty: +q, disc: dc };
    }
    const ids = Object.keys(lines).map(Number).sort((a, b) => a - b);
    if (!ids.length) out({ error: 'Add at least one product.' }, 422);
    if (ids.length > 100) out({ error: 'A sale can have up to 100 different products.' }, 422);
    const extra = cents(I.discount ?? 0); if (extra < 0) out({ error: 'The discount cannot be negative.' }, 422);
    const rate = num(I.tax_rate ?? 0); if (rate < 0 || rate > 100) out({ error: 'Tax must be between 0 and 100%.' }, 422);
    const method = str(c, 'method'), ref = mbSub(str(c, 'reference'), 0, 80), cust = mbSub(str(c, 'customer_name'), 0, 120), phone = mbSub(str(c, 'customer_phone'), 0, 40), note = mbSub(str(c, 'note'), 0, 300);
    const paidC = cents(I.amount_paid ?? 0); if (paidC < 0) out({ error: 'The amount paid cannot be negative.' }, 422);
    if (paidC > 0 && !METHODS.includes(method)) out({ error: 'Choose a payment method.' }, 422);
    const allow = !!I.allow_oversell; if (allow && !isAdmin) out({ error: 'Only an administrator can sell more than the stock.' }, 403);

    let sid, no;
    await c.tx(async () => {
      const P = {};
      for (const p of await c.all(`SELECT id,name,sku,price,stock FROM products WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids)) P[+p.id] = p;
      for (const i of ids) if (!P[i]) out({ error: 'A product in this sale no longer exists. Refresh the product list.' }, 404);
      const short = ids.filter(i => lines[i].qty > +P[i].stock).map(i => `${P[i].name} (only ${+P[i].stock} in stock, you entered ${lines[i].qty})`);
      if (short.length && !allow) out({ error: 'Not enough stock: ' + short.join('; ') + '.', short: true }, 409);
      let sub = 0, lineDisc = 0; const rows = {};
      for (const i of ids) {
        const uc = cents(P[i].price), g = uc * lines[i].qty, d = lines[i].disc;
        if (d > g) out({ error: 'The discount on ' + P[i].name + ' is more than its price.' }, 422);
        rows[i] = { uc, g, d }; sub += g; lineDisc += d;
      }
      if (extra > sub - lineDisc) out({ error: 'The discount is more than the sale total.' }, 422);
      // spread the overall discount over the lines in proportion; the last line takes the rounding difference
      const base = sub - lineDisc; let left = extra, k = 0;
      for (const i of ids) {
        k++; const ln = rows[i].g - rows[i].d;
        let share = k === ids.length ? left : (base > 0 ? Math.round(extra * ln / base) : 0); share = Math.min(share, ln, left); left -= share;
        rows[i].d += share; rows[i].net = rows[i].g - rows[i].d;
      }
      const disc = lineDisc + extra, taxable = sub - disc, tax = Math.round(taxable * rate / 100), total = taxable + tax;
      if (paidC > total) out({ error: 'The amount paid is more than the sale total.' }, 422);
      if (paidC < total && cust === '') out({ error: 'Enter the customer’s name for a part-paid or unpaid sale.' }, 422);
      no = prefix(c) + String(+(await c.val('SELECT COALESCE(MAX(id),0)+1 FROM sales'))).padStart(6, '0');
      const oversold = short.length > 0;
      await c.run('INSERT INTO sales(receipt_no,idem_key,cashier_id,customer_name,customer_phone,subtotal,discount,tax_rate,tax,total,paid,method,note,oversold) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [no, key, me, cust, phone, dmoney(sub), dmoney(disc), rate.toFixed(2), dmoney(tax), dmoney(total), dmoney(paidC), paidC > 0 ? method : '', note, oversold ? 1 : 0]);
      sid = +(await c.val('SELECT last_insert_rowid()'));
      for (const i of ids) {
        const p = P[i], q = lines[i].qty, take = Math.min(q, +p.stock), nw = +p.stock - take;
        await c.run('INSERT INTO sale_items(sale_id,product_id,name,sku,unit_price,qty,discount,net,stock_taken) VALUES(?,?,?,?,?,?,?,?,?)', [sid, i, p.name, p.sku, dmoney(rows[i].uc), q, dmoney(rows[i].d), dmoney(rows[i].net), take]);
        if (take > 0) {
          await c.run('UPDATE products SET stock=? WHERE id=?', [nw, i]);
          await mv(c, i, p.name, 'walkin', -take, nw, N(p.price), null, 'Sale ' + no + (take < q ? ` (oversold by ${q - take})` : ''), me);
        }
      }
      if (paidC > 0) await c.run('INSERT INTO sale_payments(sale_id,amount,method,reference,user_id) VALUES(?,?,?,?,?)', [sid, dmoney(paidC), method, ref, me]);
      await c.run('INSERT INTO sale_audit(sale_id,user_id,action,detail) VALUES(?,?,?,?)', [sid, me, 'created', `${no}: ${ids.length} product(s), total ${dmoney(total)}, paid ${dmoney(paidC)}` + (paidC > 0 ? ' by ' + method : '')]);
      if (oversold) await c.run('INSERT INTO sale_audit(sale_id,user_id,action,detail) VALUES(?,?,?,?)', [sid, me, 'stock override', mbSub('Sold more than the stock: ' + short.join('; '), 0, 500)]);
    });
    out({ id: sid, receipt_no: no });
  },

  async s_list(c) {
    await staff(c);
    const [w, p] = await filters(c, query(c));
    const r = (await c.all(SEL + ' ' + w + ' ORDER BY s.id DESC LIMIT 300', p)).map(row);
    out({ sales: r, limited: r.length >= 300 });
  },

  // one sale with items, payments, returns, audit trail and store details for the receipt
  async s_get(c) {
    await staff(c);
    const sale = await load(c, int(c.get('id')));
    if (!sale) out({ error: 'Sale not found.' }, 404);
    out(await full(c, sale));
  },

  // take a payment on a part-paid or unpaid sale
  async s_pay(c) {
    post(c); await staff(c); const I = c.in, me = await uid(c);
    const amt = cents(I.amount ?? 0), m = str(c, 'method'), ref = mbSub(str(c, 'reference'), 0, 80);
    if (amt <= 0) out({ error: 'Enter the amount received.' }, 422);
    if (!METHODS.includes(m)) out({ error: 'Choose a payment method.' }, 422);
    await c.tx(async () => {
      const sale = await load(c, int(I.id));
      if (!sale) out({ error: 'Sale not found.' }, 404);
      if (sale.status === 'cancelled') out({ error: 'This sale was cancelled.' }, 409);
      const bal = cents(sale.balance);
      if (bal <= 0) out({ error: 'This sale is already fully paid.' }, 409);
      if (amt > bal) out({ error: 'The balance is only ' + dmoney(bal) + '.' }, 422);
      await c.run("UPDATE sales SET paid=paid+?,method=CASE WHEN method='' THEN ? ELSE method END WHERE id=?", [dmoney(amt), m, sale.id]);
      await c.run('INSERT INTO sale_payments(sale_id,amount,method,reference,user_id) VALUES(?,?,?,?,?)', [sale.id, dmoney(amt), m, ref, me]);
      await c.run('INSERT INTO sale_audit(sale_id,user_id,action,detail) VALUES(?,?,?,?)', [sale.id, me, 'payment', dmoney(amt) + ' by ' + m + (ref !== '' ? ` (${ref})` : '')]);
    });
    out({ ok: true });
  },

  // admin: return some items of a sale, refund, and put them back in stock only if asked
  async s_return(c) {
    post(c); await admin(c); const I = c.in;
    const reason = mbSub(str(c, 'reason'), 0, 300); if (reason === '') out({ error: 'Give a reason for the return.' }, 422);
    const take = {};
    for (const it of Array.isArray(I.items) ? I.items : []) { const q = int(it?.qty); if (q > 0) { const k = int(it?.id); take[k] = (take[k] || 0) + q; } }
    let r;
    await c.tx(async () => {
      const sale = await load(c, int(I.id));
      if (!sale) out({ error: 'Sale not found.' }, 404);
      if (sale.status === 'cancelled') out({ error: 'This sale was cancelled.' }, 409);
      r = await giveBack(c, sale, take, !!I.restock, num(I.refund ?? 0), str(c, 'refund_method'), reason, false);
    });
    out({ ...r, ok: true });
  },

  // admin: cancel a whole sale; everything goes back to stock and the money paid is refunded
  async s_cancel(c) {
    post(c); await admin(c); const I = c.in, me = await uid(c);
    const reason = mbSub(str(c, 'reason'), 0, 300); if (reason === '') out({ error: 'Give a reason for cancelling this sale.' }, 422);
    let r = {};
    await c.tx(async () => {
      const sale = await load(c, int(I.id));
      if (!sale) out({ error: 'Sale not found.' }, 404);
      if (sale.status === 'cancelled') out({ error: 'This sale is already cancelled.' }, 409);
      const take = {};
      for (const x of await c.all('SELECT id,qty-returned_qty AS rem FROM sale_items WHERE sale_id=? AND qty>returned_qty', [sale.id])) take[+x.id] = +x.rem;
      if (!Object.keys(take).length) { // everything was already returned: just close the sale
        await c.run("UPDATE sales SET status='cancelled',cancel_reason=? WHERE id=?", [reason, sale.id]);
        await c.run('INSERT INTO sale_audit(sale_id,user_id,action,detail) VALUES(?,?,?,?)', [sale.id, me, 'cancelled', mbSub('All items had already been returned. Reason: ' + reason, 0, 500)]);
        return;
      }
      r = await giveBack(c, sale, take, true, Math.max(0, sale.paid), sale.method !== '' ? sale.method : 'Cash', reason, true);
    });
    out({ ...r, ok: true });
  },

  // ---- reports (admin sees the whole shop, a worker only their own sales) ----
  async s_report(c) {
    await staff(c); const today = todayStr(c);
    const from = c.get('from') || today, to = c.get('to') || today;
    if (!validDate(from) || !validDate(to) || to < from) out({ error: 'Choose a valid period.' }, 422);
    if ((Date.parse(to) - Date.parse(from)) > 366 * 86400000) out({ error: 'A report can cover up to one year.' }, 422);
    out({ ...(await reportData(c, from, to, c.get('cashier'))), from, to, scope: (await own(c)) ? 'mine' : 'all' });
  },

  // dashboard cards: today, this month, top sellers, unpaid balances
  async s_summary(c) {
    await staff(c); const today = todayStr(c);
    const day = await reportData(c, today, today, c.get('cashier')), month = await reportData(c, today.slice(0, 8) + '01', today, c.get('cashier'));
    out({ scope: (await own(c)) ? 'mine' : 'all', today: { net: day.totals.net, n: day.totals.n }, month: { net: month.totals.net, n: month.totals.n, units: month.totals.units },
      outstanding: month.totals.outstanding, top: month.top.slice(0, 3) });
  },

  // CSV that opens in Excel; add detail=items for one row per product sold
  async s_export(c) {
    await staff(c);
    const [w, p] = await filters(c, query(c)), items = c.get('detail') === 'items', lines = [];
    if (items) {
      lines.push(['Receipt', 'Date', 'Cashier', 'Customer', 'Product', 'SKU', 'Qty', 'Returned qty', 'Unit price', 'Discount', 'Net (before tax)', 'Status']);
      const rs = await c.all(`SELECT s.receipt_no,to_char(s.created_at,'YYYY-MM-DD HH24:MI') AS at,u.name AS cashier,s.customer_name,i.name,i.sku,i.qty,i.returned_qty,i.unit_price,i.discount,i.net,s.status
        FROM sale_items i JOIN sales s ON s.id=i.sale_id LEFT JOIN users u ON u.id=s.cashier_id ${w} ORDER BY s.id DESC,i.id LIMIT 50000`, p);
      for (const r of rs) lines.push([cx(r.receipt_no), r.at, cx(r.cashier ?? ''), cx(r.customer_name), cx(r.name), cx(r.sku), r.qty, r.returned_qty, r.unit_price, r.discount, r.net, r.status]);
    } else {
      lines.push(['Receipt', 'Date', 'Cashier', 'Customer', 'Phone', 'Status', 'Payment status', 'Method', 'Gross', 'Discount', 'Tax', 'Total', 'Returned', 'Net sales', 'Paid', 'Balance']);
      for (const r of (await c.all(SEL + ' ' + w + ' ORDER BY s.id DESC LIMIT 50000', p)).map(row))
        lines.push([cx(r.receipt_no), r.at, cx(r.cashier), cx(r.customer_name), cx(r.customer_phone), r.status, r.pstatus, r.method, r.subtotal, r.discount, r.tax, r.total, r.returned, r.net, r.paid, r.balance]);
    }
    rawOut('\uFEFF' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n',
      { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="sales-${todayStr(c)}${items ? '-items' : ''}.csv"` });
  },
};

// Shared by s_return and s_cancel. take: {sale_item_id: qty}. Runs inside the caller's transaction (out() rolls it back).
async function giveBack(c, sale, take, restock, refund, method, reason, cancel) {
  const me = await uid(c), rate = sale.tax_rate;
  const items = {}; for (const r of await c.all('SELECT * FROM sale_items WHERE sale_id=? ORDER BY id', [sale.id])) items[+r.id] = r;
  let valEx = 0; const plan = {};
  for (const [k, q] of Object.entries(take)) {
    const iid = +k, it = items[iid];
    if (!it) out({ error: 'That item is not part of this sale.' }, 422);
    const remain = +it.qty - +it.returned_qty;
    if (q < 1 || q > remain) out({ error: `${it.name}: only ${remain} left that can be returned.` }, 409);
    const netC = cents(it.net), rn = cents(it.returned_net), v = q === remain ? netC - rn : Math.round(netC * q / +it.qty);
    valEx += v; plan[iid] = { q, v };
  }
  if (!Object.keys(plan).length) out({ error: 'Choose the items and quantities to return.' }, 422);
  let value = Math.round(valEx * (1 + rate / 100)), left = 0;
  for (const it of Object.values(items)) left += +it.qty - +it.returned_qty - (plan[+it.id]?.q || 0);
  if (left === 0) value = cents(sale.total) - cents(sale.returned); // finishing the sale: no rounding drift
  const newRet = cents(sale.returned) + value, maxRefund = Math.max(0, cents(sale.paid) - (cents(sale.total) - newRet));
  let refC = cents(refund); if (cancel) refC = Math.min(refC, maxRefund);
  if (refC < 0 || refC > maxRefund) out({ error: 'The refund can be at most ' + dmoney(maxRefund) + ' (what the customer has paid beyond what they now owe).' }, 422);
  if (refC > 0 && !METHODS.includes(method)) out({ error: 'Choose how the refund is paid.' }, 422);
  await c.run('INSERT INTO sale_returns(sale_id,value,refund,refund_method,restock,cancel,reason,user_id) VALUES(?,?,?,?,?,?,?,?)', [sale.id, dmoney(value), dmoney(refC), refC > 0 ? method : '', restock ? 1 : 0, cancel ? 1 : 0, reason, me]);
  const rid = +(await c.val('SELECT last_insert_rowid()'));
  let restockedTotal = 0;
  for (const [k, pl] of Object.entries(plan)) {
    const iid = +k, it = items[iid]; let back = 0;
    if (restock && it.product_id !== null) {
      back = Math.min(pl.q, +it.stock_taken - +it.restocked);
      if (back > 0) {
        const cur = await c.val('SELECT stock FROM products WHERE id=?', [it.product_id]);
        if (cur !== null && cur !== undefined) {
          const nw = +cur + back;
          await c.run('UPDATE products SET stock=? WHERE id=?', [nw, it.product_id]);
          await mv(c, +it.product_id, it.name, 'return', back, nw, N(it.unit_price), null, (cancel ? 'Cancelled ' : 'Return of ') + sale.receipt_no, me);
          restockedTotal += back;
        } else back = 0;
      }
    }
    await c.run('UPDATE sale_items SET returned_qty=returned_qty+?,returned_net=returned_net+?,restocked=restocked+? WHERE id=?', [pl.q, dmoney(pl.v), back, iid]);
    await c.run('INSERT INTO sale_return_items(return_id,sale_item_id,qty,restocked) VALUES(?,?,?,?)', [rid, iid, pl.q, back]);
  }
  let allBack = true;
  for (const it of Object.values(items)) if (+it.returned_qty + (plan[+it.id]?.q || 0) < +it.qty) allBack = false;
  const status = cancel ? 'cancelled' : (allBack ? 'returned' : 'completed');
  await c.run('UPDATE sales SET returned=returned+?,paid=paid-?,status=?,cancel_reason=CASE WHEN ? THEN ? ELSE cancel_reason END WHERE id=?', [dmoney(value), dmoney(refC), status, cancel ? 1 : 0, reason, sale.id]);
  await c.run('INSERT INTO sale_audit(sale_id,user_id,action,detail) VALUES(?,?,?,?)', [sale.id, me, cancel ? 'cancelled' : 'return',
    mbSub((cancel ? 'Sale cancelled. ' : '') + `Value ${dmoney(value)}, refunded ${dmoney(refC)}` + (refC > 0 ? ' by ' + method : '') + ', ' + (restock ? restockedTotal + ' unit(s) back in stock' : 'not restocked') + '. Reason: ' + reason, 0, 500)]);
  return { value: value / 100, refund: refC / 100, restocked: restockedTotal };
}

async function reportData(c, from, to, cashier) {
  const [w, p] = await filters(c, { from, to, cashier });
  const t = await c.one(`SELECT COUNT(*) FILTER (WHERE s.status<>'cancelled') AS n,COALESCE(SUM(s.subtotal),0) AS gross,COALESCE(SUM(s.discount),0) AS discounts,COALESCE(SUM(s.tax),0) AS tax,
    COALESCE(SUM(s.total),0) AS total,COALESCE(SUM(s.returned),0) AS returned,COALESCE(SUM(s.paid),0) AS collected,
    COALESCE(SUM(CASE WHEN s.status<>'cancelled' THEN GREATEST(s.total-s.returned-s.paid,0) ELSE 0 END),0) AS outstanding,
    COALESCE(SUM((SELECT SUM(qty-returned_qty) FROM sale_items i WHERE i.sale_id=s.id)),0) AS units FROM sales s ${w}`, p);
  for (const k of Object.keys(t)) t[k] = N(t[k]);
  t.refunds = N(await c.val(`SELECT COALESCE(SUM(r.refund),0) FROM sale_returns r JOIN sales s ON s.id=r.sale_id ${w}`, p));
  t.net = Math.round((t.total - t.returned) * 100) / 100;
  t.avg = t.n > 0 ? Math.round(t.net / t.n * 100) / 100 : 0;
  const top = (await c.all(`SELECT i.product_id,i.name,SUM(i.qty-i.returned_qty) AS units,COALESCE(SUM(i.net-i.returned_net),0) AS revenue FROM sale_items i JOIN sales s ON s.id=i.sale_id ${w} AND s.status<>'cancelled'
    GROUP BY i.product_id,i.name HAVING SUM(i.qty-i.returned_qty)>0 ORDER BY units DESC,revenue DESC LIMIT 10`, p)).map(r => ({ ...r, units: N(r.units), revenue: N(r.revenue) }));
  const days = (await c.all(`SELECT to_char(s.created_at,'YYYY-MM-DD') AS day,COUNT(*) FILTER (WHERE s.status<>'cancelled') AS n,COALESCE(SUM(s.total-s.returned),0) AS net FROM sales s ${w} GROUP BY 1 ORDER BY 1`, p)).map(r => ({ ...r, n: N(r.n), net: N(r.net) }));
  const methods = (await c.all(`SELECT s.method,COUNT(*) AS n,COALESCE(SUM(s.paid),0) AS paidsum FROM sales s ${w} AND s.method<>'' GROUP BY s.method ORDER BY paidsum DESC`, p)).map(r => ({ method: r.method, n: N(r.n), paid: N(r.paidsum) }));
  let by = [];
  if (!(await own(c))) by = (await c.all(`SELECT COALESCE(u.name,'(removed)') AS name,COUNT(*) AS n,COALESCE(SUM(s.total-s.returned),0) AS net FROM sales s LEFT JOIN users u ON u.id=s.cashier_id ${w} GROUP BY 1 ORDER BY net DESC`, p)).map(r => ({ ...r, n: N(r.n), net: N(r.net) }));
  for (const k of ['gross', 'discounts', 'tax', 'total', 'returned', 'collected', 'outstanding']) t[k] = Math.round(t[k] * 100) / 100;
  return { totals: t, top, days, methods, cashiers: by };
}
