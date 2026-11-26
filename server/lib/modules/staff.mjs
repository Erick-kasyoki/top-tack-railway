// Ports of: catalog, orders, inventory, workers, customers, admins (app/modules/*).
import {
  out, rawOut, post, str, int, num, isEmail, mbSub, money2, hashPw, cfg, newPw, cx, ix, inum, csvCell, imgOk, PCOLS, prodA,
  uid, role, meRow, admin, staff, mv, nfAdd, nfMoney, tillNo, bhMinutes, contentGet, contentSave, upGc, upOk, savePhoto, todayStr,
} from '../core.mjs';

const STATUSES = ['pending', 'confirmed', 'dispatched', 'delivered', 'cancelled'];
const isUnique = x => x && x.code === '23505';

export const routes = {
  // =============== catalog ===============
  async a_products(c) {
    await staff(c);
    const L = (await c.all(`SELECT ${PCOLS} FROM products ORDER BY id`)).map(prodA);
    if ((await role(c)) !== 'admin') L.forEach(p => { p.cost = null; });
    const bs = new Set((await c.all('SELECT id FROM products WHERE best_seller')).map(r => +r.id));
    L.forEach(p => { p.best = bs.has(p.id); });
    out(L);
  },
  async a_content(c) { await admin(c); out(contentGet(c)); },
  async a_content_save(c) { post(c); await admin(c); await contentSave(c, c.in); out({ ok: true }); },

  async a_best(c) {
    post(c); await admin(c);
    const id = int(c.in.id), on = !!c.in.on;
    await c.tx(async () => {
      const cur = await c.one('SELECT best_seller FROM products WHERE id=? FOR UPDATE', [id]);
      if (!cur) out({ error: 'Unknown product.' }, 404);
      if (on && !cur.best_seller && +(await c.val('SELECT COUNT(*) FROM products WHERE best_seller')) >= 8) out({ error: 'The store shows up to 8 best sellers. Remove one first.' }, 409);
      if (on) await c.run('UPDATE products SET best_seller=true,best_pos=CASE WHEN best_seller THEN best_pos ELSE (SELECT COALESCE(MAX(best_pos),0)+1 FROM products) END WHERE id=?', [id]);
      else await c.run('UPDATE products SET best_seller=false,best_pos=0 WHERE id=?', [id]);
    });
    out({ ok: true });
  },
  async a_best_clear(c) { post(c); await admin(c); await c.run('UPDATE products SET best_seller=false,best_pos=0'); out({ ok: true }); },

  async a_save(c) {
    post(c); await admin(c);
    const I = c.in, w = num(I.was), img = str(c, 'image'), cost = String(I.cost ?? '').trim();
    const f = [str(c, 'name'), str(c, 'descr'), num(I.price), w > 0 ? w : null, str(c, 'emoji') || '📦', imgOk(img) ? img : '', str(c, 'dept'), Math.max(0, int(I.stock)),
      mbSub(str(c, 'sku'), 0, 40), cost !== '' && num(cost) >= 0 ? num(cost) : null, Math.max(0, I.reorder_level === undefined ? 5 : int(I.reorder_level))];
    if (f[0] === '' || f[6] === '' || f[2] < 0) out({ error: 'Name, department and a valid price are required.' }, 422);
    let id = int(I.id), oldImg;
    await c.tx(async () => {
      if (id) {
        const or = await c.one('SELECT stock,image FROM products WHERE id=? FOR UPDATE', [id]);
        if (!or) out({ error: 'Unknown product.' }, 404);
        oldImg = or.image;
        await c.run('UPDATE products SET name=?,descr=?,price=?,was=?,emoji=?,image=?,dept=?,stock=?,sku=?,cost=?,reorder_level=? WHERE id=?', [...f, id]);
        if (+or.stock !== f[7]) await mv(c, id, f[0], 'adjust', f[7] - +or.stock, f[7], null, null, 'Edited in product form', await uid(c));
      } else {
        id = +(await c.val('INSERT INTO products(name,descr,price,was,emoji,image,dept,stock,sku,cost,reorder_level) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id', f));
        if (f[7] > 0) await mv(c, id, f[0], 'opening', f[7], f[7], null, null, 'New product', await uid(c));
      }
    });
    if (!int(I.id)) await nfAdd(c, 'customers', null, 'product_new', 'New in store: ' + f[0], nfMoney(c, f[2]), 's:' + f[0]);
    if (oldImg !== undefined && oldImg !== f[5]) await upGc(c, [oldImg]);
    out({ ok: true });
  },

  async a_delete(c) {
    post(c); await admin(c);
    const id = int(c.in.id), im = await c.val('SELECT image FROM products WHERE id=?', [id]);
    await c.run('DELETE FROM products WHERE id=?', [id]);
    if (im) await upGc(c, [im]);
    out({ ok: true });
  },

  async a_delete_all(c) {
    post(c); await admin(c);
    if (str(c, 'confirm') !== 'DELETE ALL') out({ error: 'Type DELETE ALL to confirm.' }, 422);
    let imgs, n;
    await c.tx(async () => { imgs = (await c.all("SELECT image FROM products WHERE image LIKE 'img/uploads/%'")).map(r => r.image); n = await c.exec('DELETE FROM products'); });
    await upGc(c, imgs);
    out({ ok: true, deleted: n });
  },

  async a_upload(c) { await admin(c); out({ ok: true, path: await savePhoto(c, '') }); },

  // Whole-database backup: the SQLite file, as it is right now.
  async a_backup(c) {
    await admin(c);
    await c.run('SELECT 1');
    const bytes = Buffer.from(c._db.export());
    rawOut(bytes, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="top-tack-backup-${todayStr(c)}.sqlite"` });
  },

  async a_export(c) {
    await admin(c);
    const rows = [['name', 'description', 'department', 'price', 'old_price', 'stock', 'reorder_level', 'sku', 'unit_cost', 'emoji', 'image']];
    for (const p of await c.all(`SELECT ${PCOLS} FROM products ORDER BY id`))
      rows.push([cx(p.name), cx(p.descr), cx(p.dept), p.price, p.was ?? '', p.stock, p.reorder_level, cx(p.sku), p.cost ?? '', p.emoji, cx(p.image)]);
    rawOut('\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n', { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="products-${todayStr(c)}.csv"` });
  },

  async a_import(c) {
    post(c); await admin(c);
    const rows = c.in.rows;
    if (!Array.isArray(rows) || !rows.length) out({ error: 'There are no rows to import.' }, 422);
    if (rows.length > 5000) out({ error: 'Import up to 5000 products at a time.' }, 422);
    const mode = (c.in.mode ?? 'upsert') === 'add' ? 'add' : 'upsert', me = await uid(c);
    let added = 0, updated = 0, skipped = 0; const errs = [];
    const bad = (n, why) => { skipped++; if (errs.length < 25) errs.push('Row ' + n + ': ' + why); };
    await c.tx(async () => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i], n = i + 2;
        if (!r || typeof r !== 'object') { bad(n, 'not a valid row.'); continue; }
        const t = k => ix(r[k] ?? '');
        const name = mbSub(t('name'), 0, 200), dept = mbSub(t('dept'), 0, 100);
        if (name === '' || dept === '') { bad(n, 'name and department are required.'); continue; }
        const price = inum(r.price ?? '');
        if (price === null || price === false || price < 0) { bad(n, 'price must be a number, 0 or more.'); continue; }
        const was = inum(r.was ?? ''), cost = inum(r.cost ?? ''), stock = inum(r.stock ?? ''), ro = inum(r.reorder_level ?? '');
        if (was === false || cost === false || stock === false || ro === false || (cost !== null && cost < 0)) { bad(n, 'old price, stock, reorder level and unit cost must be numbers.'); continue; }
        const sku = mbSub(t('sku'), 0, 40); let img = t('image'); if (!imgOk(img)) img = '';
        let ex = null;
        if (mode === 'upsert') {
          if (sku !== '') ex = await c.one(`SELECT ${PCOLS} FROM products WHERE sku<>'' AND lower(sku)=lower(?) ORDER BY id LIMIT 1 FOR UPDATE`, [sku]);
          if (!ex) ex = await c.one(`SELECT ${PCOLS} FROM products WHERE lower(name)=lower(?) AND lower(dept)=lower(?) ORDER BY id LIMIT 1 FOR UPDATE`, [name, dept]);
        }
        if (ex) {
          const nw = was === null ? num(ex.was) : was, ns = stock === null ? +ex.stock : Math.max(0, Math.trunc(stock));
          await c.run('UPDATE products SET name=?,descr=?,price=?,was=?,emoji=?,image=?,dept=?,stock=?,sku=?,cost=?,reorder_level=? WHERE id=?',
            [name, t('descr') !== '' ? t('descr') : ex.descr, money2(price), nw > 0 ? money2(nw) : null, t('emoji') !== '' ? mbSub(t('emoji'), 0, 8) : ex.emoji, img !== '' ? img : ex.image, dept, ns,
              sku !== '' ? sku : ex.sku, cost === null ? ex.cost : money2(cost), ro === null ? +ex.reorder_level : Math.max(0, Math.trunc(ro)), +ex.id]);
          if (ns !== +ex.stock) await mv(c, +ex.id, name, 'adjust', ns - +ex.stock, ns, null, null, 'Product import', me);
          updated++;
        } else {
          const ns = stock === null ? 0 : Math.max(0, Math.trunc(stock));
          const id = +(await c.val('INSERT INTO products(name,descr,price,was,emoji,image,dept,stock,sku,cost,reorder_level) VALUES(?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
            [name, t('descr'), money2(price), was !== null && was > 0 ? money2(was) : null, t('emoji') !== '' ? mbSub(t('emoji'), 0, 8) : '📦', img, dept, ns, sku, cost === null ? null : money2(cost), ro === null ? 5 : Math.max(0, Math.trunc(ro))]));
          if (ns > 0) await mv(c, id, name, 'opening', ns, ns, null, null, 'Product import', me);
          added++;
        }
      }
    });
    if (added > 0) await nfAdd(c, 'customers', null, 'product_new', added + ' new product' + (added > 1 ? 's' : '') + ' added to the store', 'Take a look at what is new.', 's:');
    out({ ok: true, added, updated, skipped, errors: errs });
  },

  async a_dept_rename(c) {
    post(c); await admin(c);
    const from = str(c, 'from'), to = str(c, 'to'); if (from === '' || to === '') out({ error: 'Enter the new department name.' }, 422);
    out({ ok: true, changed: await c.exec('UPDATE products SET dept=? WHERE dept=?', [to, from]) });
  },

  async a_bulk_price(c) {
    post(c); await admin(c);
    const pct = num(c.in.percent), d = str(c, 'dept');
    if (pct <= -100 || pct > 1000 || pct === 0) out({ error: 'Enter a percentage other than 0 (for example 10 or -5).' }, 422);
    out({ ok: true, changed: await c.exec("UPDATE products SET price=GREATEST(0,ROUND(price*(1+?::numeric/100),2)) WHERE (?::text='' OR dept=?::text)", [pct, d, d]) });
  },

  // =============== orders ===============
  async a_orders(c) {
    await staff(c);
    const r = await c.all(`SELECT o.id,(o.paid_at IS NOT NULL) AS paid,to_char(o.paid_at,'YYYY-MM-DD HH24:MI') AS paid_at,pb.name AS paid_by_name,
      (SELECT receipt FROM mpesa_payments m WHERE m.order_id=o.id AND m.status='success' AND NOT m.needs_review ORDER BY m.id DESC LIMIT 1) AS mpesa_receipt,
      o.total::float8 AS total,o.status,o.name,o.phone,o.address,o.note,o.payment,o.assigned_to,aw.name AS assigned_name,ub.name AS updated_by_name,
      to_char(o.updated_at,'YYYY-MM-DD HH24:MI') AS updated_at,to_char(o.created_at,'YYYY-MM-DD HH24:MI') AS at,extract(epoch from o.created_at)::bigint AS ts,
      (SELECT COALESCE(json_agg(json_build_object('name',i.name,'qty',i.qty)),'[]'::json) FROM order_items i WHERE i.order_id=o.id) AS items
      FROM orders o LEFT JOIN users aw ON aw.id=o.assigned_to LEFT JOIN users ub ON ub.id=o.updated_by LEFT JOIN users pb ON pb.id=o.paid_by ORDER BY o.id DESC LIMIT 200`).catch(async e => {
      if (e.code !== '42P01') throw e; // mpesa_payments not created yet: same query without the M-Pesa column
      return c.all(`SELECT o.id,(o.paid_at IS NOT NULL) AS paid,to_char(o.paid_at,'YYYY-MM-DD HH24:MI') AS paid_at,pb.name AS paid_by_name,NULL AS mpesa_receipt,
        o.total::float8 AS total,o.status,o.name,o.phone,o.address,o.note,o.payment,o.assigned_to,aw.name AS assigned_name,ub.name AS updated_by_name,
        to_char(o.updated_at,'YYYY-MM-DD HH24:MI') AS updated_at,to_char(o.created_at,'YYYY-MM-DD HH24:MI') AS at,extract(epoch from o.created_at)::bigint AS ts,
        (SELECT COALESCE(json_agg(json_build_object('name',i.name,'qty',i.qty)),'[]'::json) FROM order_items i WHERE i.order_id=o.id) AS items
        FROM orders o LEFT JOIN users aw ON aw.id=o.assigned_to LEFT JOIN users ub ON ub.id=o.updated_by LEFT JOIN users pb ON pb.id=o.paid_by ORDER BY o.id DESC LIMIT 200`);
    });
    const tgt = num(cfg(c, 'BH_TARGET', '0')) * 60, warn = Math.max(1, int(cfg(c, 'BH_WARN', '75'))), now = Math.floor(Date.now() / 1000);
    for (const o of r) {
      o.paid = !!o.paid; o.items = Array.isArray(o.items) ? o.items : (() => { try { const j = JSON.parse(o.items); return Array.isArray(j) ? j : []; } catch (e) { return []; } })(); o.assigned_to = o.assigned_to === null ? null : +o.assigned_to; o.sla = null;
      if (tgt > 0 && ['pending', 'confirmed', 'dispatched'].includes(o.status)) { const pct = Math.round(bhMinutes(c, +o.ts, now) / tgt * 100); o.sla = { pct, state: pct >= 100 ? 'breached' : (pct >= warn ? 'warning' : 'ok') }; }
      delete o.ts;
    }
    out(r);
  },

  async a_status(c) {
    post(c); await staff(c);
    const id = int(c.in.id), st = str(c, 'status'), me = await uid(c), rl = await role(c);
    if (!STATUSES.includes(st)) out({ error: 'Unknown status.' }, 422);
    let old;
    await c.tx(async () => {
      const o0 = await c.one('SELECT status,assigned_to,paid_at IS NOT NULL AS paid FROM orders WHERE id=? FOR UPDATE', [id]);
      if (!o0) out({ error: 'Unknown order.' }, 404);
      old = o0.status;
      if (rl === 'worker' && o0.assigned_to !== null && +o0.assigned_to !== me) out({ error: 'This order is handled by another worker.' }, 403);
      if (old === 'cancelled' && st !== 'cancelled') out({ error: 'Cancelled orders can’t be reopened.' }, 409);
      if (['dispatched', 'delivered'].includes(st) && old !== st && !o0.paid) out({ error: 'Payment for order #' + id + ' is not confirmed yet. Confirm the till payment first, then dispatch.' }, 409);
      if (st === 'cancelled' && old !== 'cancelled') {
        for (const r of await c.all('SELECT i.product_id,i.name,i.qty,i.unit_price FROM order_items i WHERE i.order_id=? AND i.product_id IS NOT NULL ORDER BY i.product_id', [id])) {
          const a = await c.val('UPDATE products SET stock=stock+? WHERE id=? RETURNING stock', [r.qty, r.product_id]);
          await mv(c, +r.product_id, r.name, 'return', +r.qty, +a, num(r.unit_price), id, 'Order #' + id + ' cancelled', me);
        }
      }
      await c.run('UPDATE orders SET status=?,updated_at=now(),updated_by=?,assigned_to=COALESCE(assigned_to,?) WHERE id=?', [st, me, rl === 'worker' ? me : null, id]);
    });
    if (st !== old) {
      const q = await c.one('SELECT user_id,total FROM orders WHERE id=?', [id]), cu = q ? +q.user_id : 0, by = (await meRow(c))?.name || 'Staff';
      const say = { confirmed: 'is confirmed and being prepared', dispatched: 'is on its way to you', delivered: 'was delivered. Thank you for shopping with us!', cancelled: 'was cancelled' };
      if (st === 'confirmed' && cu) {
        const tn = tillNo(c), tt = nfMoney(c, q.total);
        if (tn !== '') await nfAdd(c, '', cu, 'mine_pay', 'Order #' + id + ' confirmed. Please pay ' + tt + ' to Till Number ' + tn, 'M-PESA > Lipa na M-PESA > Buy Goods and Services. We dispatch your order once payment is confirmed.', 'orders');
        else { await nfAdd(c, '', cu, 'mine_pay', 'Order #' + id + ' confirmed. Payment is required before dispatch', 'We will send you our till number shortly.', 'orders'); await nfAdd(c, 'staff', null, 'order_paid', 'Set the M-PESA till number in Settings', 'Order #' + id + ' was confirmed but customers have no till number to pay yet.', 'tab:o'); }
      } else if (say[st] && cu) await nfAdd(c, '', cu, 'mine_order', 'Your order #' + id + ' ' + say[st], '', 'orders');
      await nfAdd(c, 'staff', null, 'order_status', 'Order #' + id + ' marked ' + st, 'By ' + by, 'tab:o');
    }
    out({ ok: true });
  },

  async a_paid(c) {
    post(c); await staff(c);
    const id = int(c.in.id), yes = !('paid' in c.in) || !!c.in.paid, me = await uid(c), rl = await role(c);
    let o0, done = false;
    await c.tx(async () => {
      o0 = await c.one('SELECT status,assigned_to,user_id,total,paid_at IS NOT NULL AS paid FROM orders WHERE id=? FOR UPDATE', [id]);
      if (!o0) out({ error: 'Unknown order.' }, 404);
      if (rl === 'worker' && o0.assigned_to !== null && +o0.assigned_to !== me) out({ error: 'This order is handled by another worker.' }, 403);
      if (o0.status !== 'confirmed') out({ error: yes ? 'Confirm the order first, then confirm its payment.' : 'Payment can only be changed while the order is confirmed (not yet dispatched).' }, 409);
      if (!!o0.paid === yes) { done = true; return; }
      await c.run('UPDATE orders SET paid_at=' + (yes ? 'now()' : 'NULL') + ',paid_by=' + (yes ? '?' : 'NULL') + ',updated_at=now(),updated_by=?,assigned_to=COALESCE(assigned_to,?) WHERE id=?', [...(yes ? [me] : []), me, rl === 'worker' ? me : null, id]);
    });
    if (done) out({ ok: true });
    const by = (await meRow(c))?.name || 'Staff', cu = +o0.user_id;
    if (yes) { if (cu) await nfAdd(c, '', cu, 'mine_paid', 'Payment received for order #' + id + '. Thank you!', 'Your order will be dispatched shortly.', 'orders'); await nfAdd(c, 'staff', null, 'order_paid', 'Payment confirmed for order #' + id, 'By ' + by + ' · ' + nfMoney(c, o0.total), 'tab:o'); }
    else await nfAdd(c, 'staff', null, 'order_paid', 'Payment on order #' + id + ' was marked unpaid', 'By ' + by, 'tab:o');
    out({ ok: true });
  },

  async a_assign(c) {
    post(c); await staff(c);
    const id = int(c.in.id), w = int(c.in.worker_id), me = await uid(c), rl = await role(c);
    const cur = await c.one('SELECT assigned_to,user_id FROM orders WHERE id=?', [id]);
    if (!cur) out({ error: 'Unknown order.' }, 404);
    const ca = cur.assigned_to === null ? null : +cur.assigned_to;
    if (rl === 'worker') {
      if (w !== 0 && w !== me) out({ error: 'Workers can only take orders for themselves.' }, 403);
      if (w === 0 && ca !== me) out({ error: 'You can only release your own orders.' }, 403);
      if (w !== 0 && ca !== null && ca !== me) out({ error: 'Another worker already has this order.' }, 409);
    } else if (w !== 0) {
      if (!(await c.one("SELECT 1 FROM users WHERE id=? AND role='worker' AND active", [w]))) out({ error: 'Choose an active worker.' }, 422);
    }
    await c.run('UPDATE orders SET assigned_to=?,updated_at=now(),updated_by=? WHERE id=?', [w || null, me, id]);
    const by = (await meRow(c))?.name || 'Staff';
    if (w) {
      const wn = await c.val('SELECT name FROM users WHERE id=?', [w]);
      await nfAdd(c, 'staff', null, 'order_assign', 'Order #' + id + ' assigned to ' + wn, 'By ' + by, 'tab:o');
      if (w !== me) await nfAdd(c, '', w, 'mine_assign', 'Order #' + id + ' was assigned to you', 'By ' + by, 'tab:o');
      const cu = +cur.user_id; if (cu && ca !== w) await nfAdd(c, '', cu, 'mine_order', 'A team member is now working on your order #' + id, '', 'orders');
    } else await nfAdd(c, 'staff', null, 'order_assign', 'Order #' + id + ' released', 'By ' + by, 'tab:o');
    out({ ok: true });
  },

  async a_counts(c) {
    await staff(c);
    const r = await c.one("SELECT COUNT(*) FILTER(WHERE status='pending')::int AS pending,COUNT(*) FILTER(WHERE assigned_to IS NULL AND status IN('pending','confirmed','dispatched'))::int AS unassigned,COALESCE(MAX(id),0)::int AS last_order FROM orders");
    r.low = +(await c.val('SELECT COUNT(*) FROM products WHERE stock<=reorder_level'));
    r.mine = +(await c.val("SELECT COUNT(*)::int FROM orders WHERE assigned_to=? AND status IN('pending','confirmed','dispatched')", [await uid(c)]));
    r.currency = cfg(c, 'CURRENCY', '$'); r.site_name = cfg(c, 'SITE_NAME', 'Store');
    out(r);
  },

  async a_order_save(c) {
    post(c); await admin(c);
    const I = c.in, id = int(I.id), me = await uid(c); let tot = 0;
    await c.tx(async () => {
      const old = await c.val('SELECT status FROM orders WHERE id=? FOR UPDATE', [id]);
      if (old === null) out({ error: 'Unknown order.' }, 404);
      const nm = str(c, 'name'), ph = str(c, 'phone'), ad = str(c, 'address'), nt = str(c, 'note'), pay = mbSub(str(c, 'payment'), 0, 60);
      if (nm === '' || ad === '') out({ error: 'Name and address are required.' }, 422);
      const st = str(c, 'status') || old;
      if (!STATUSES.includes(st)) out({ error: 'Unknown status.' }, 422);
      if (['dispatched', 'delivered'].includes(st) && old !== st && !(await c.val('SELECT paid_at IS NOT NULL FROM orders WHERE id=?', [id]))) out({ error: 'Payment for order #' + id + ' is not confirmed yet. Confirm the till payment first, then dispatch.' }, 409);
      if (old === 'cancelled' && st !== 'cancelled') out({ error: 'Cancelled orders can’t be reopened. Edit the details only, or make a new order.' }, 409);
      const cur = {}; for (const r of await c.all('SELECT id,product_id,name,qty,unit_price FROM order_items WHERE order_id=? ORDER BY id FOR UPDATE', [id])) cur[+r.id] = r;
      const want = Array.isArray(I.items) ? I.items : null;
      if (want !== null && old !== 'cancelled') {
        const seen = new Set();
        for (const w of want) {
          const iid = int(w.id), qty = int(w.qty), pr = num(w.unit_price);
          if (pr < 0 || qty < 0 || qty > 100000) out({ error: 'Check the quantities and prices.' }, 422);
          if (!cur[iid]) out({ error: 'Unknown order line.' }, 422);
          seen.add(iid); const ln = cur[iid], diff = qty - +ln.qty;
          if (diff !== 0 && ln.product_id !== null) {
            const a = await c.val('UPDATE products SET stock=stock+? WHERE id=? AND stock+?>=0 RETURNING stock', [-diff, ln.product_id, -diff]);
            if (a === null) out({ error: ln.name + ': not enough stock for that quantity.' }, 409);
            await mv(c, +ln.product_id, ln.name, diff > 0 ? 'sale' : 'return', -diff, +a, pr, id, 'Order #' + id + ' edited by admin', me);
          }
          if (qty === 0) await c.run('DELETE FROM order_items WHERE id=?', [iid]);
          else await c.run('UPDATE order_items SET qty=?,unit_price=? WHERE id=?', [qty, money2(pr), iid]);
        }
        for (const [iid, ln] of Object.entries(cur)) if (!seen.has(+iid)) {
          if (ln.product_id !== null) { const a = await c.val('UPDATE products SET stock=stock+? WHERE id=? RETURNING stock', [ln.qty, ln.product_id]); await mv(c, +ln.product_id, ln.name, 'return', +ln.qty, +a, num(ln.unit_price), id, 'Order #' + id + ' line removed by admin', me); }
          await c.run('DELETE FROM order_items WHERE id=?', [+iid]);
        }
      }
      if (st === 'cancelled' && old !== 'cancelled') {
        for (const r of await c.all('SELECT product_id,name,qty,unit_price FROM order_items WHERE order_id=? AND product_id IS NOT NULL ORDER BY product_id', [id])) {
          const a = await c.val('UPDATE products SET stock=stock+? WHERE id=? RETURNING stock', [r.qty, r.product_id]);
          await mv(c, +r.product_id, r.name, 'return', +r.qty, +a, num(r.unit_price), id, 'Order #' + id + ' cancelled', me);
        }
      }
      tot = num(await c.val('SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id=?', [id]));
      if (I.total !== undefined && I.total !== '' && want === null) tot = Math.max(0, num(I.total));
      await c.run('UPDATE orders SET name=?,phone=?,address=?,note=?,payment=?,status=?,total=?,updated_at=now(),updated_by=? WHERE id=?', [nm, ph, ad, nt, pay !== '' ? pay : 'Cash on delivery', st, money2(tot), me, id]);
      if ('assigned_to' in I) await c.run('UPDATE orders SET assigned_to=? WHERE id=?', [int(I.assigned_to) || null, id]);
    });
    out({ ok: true, total: tot });
  },

  async a_order_items(c) {
    await admin(c);
    out(await c.all('SELECT id,product_id,name,qty,unit_price::float8 AS unit_price FROM order_items WHERE order_id=? ORDER BY id', [int(c.get('id'))]));
  },

  async a_order_delete(c) {
    post(c); await admin(c);
    const id = int(c.in.id), me = await uid(c);
    await c.tx(async () => {
      const st = await c.val('SELECT status FROM orders WHERE id=? FOR UPDATE', [id]);
      if (st === null) out({ error: 'Unknown order.' }, 404);
      if (st !== 'cancelled' && !c.in.keep_stock) {
        for (const r of await c.all('SELECT product_id,name,qty,unit_price FROM order_items WHERE order_id=? AND product_id IS NOT NULL ORDER BY product_id', [id])) {
          const a = await c.val('UPDATE products SET stock=stock+? WHERE id=? RETURNING stock', [r.qty, r.product_id]);
          await mv(c, +r.product_id, r.name, 'return', +r.qty, +a, num(r.unit_price), null, 'Order #' + id + ' deleted', me);
        }
      }
      await c.run('DELETE FROM orders WHERE id=?', [id]);
    });
    out({ ok: true });
  },

  // =============== inventory ===============
  async a_inventory(c) {
    await staff(c);
    const r = await c.all(`SELECT p.id,p.name,p.emoji,p.dept,p.sku,p.price::float8 AS price,p.cost::float8 AS cost,p.stock,p.reorder_level,
      COALESCE((SELECT SUM(-m.qty_change) FROM stock_movements m WHERE m.product_id=p.id AND m.kind IN ('sale','walkin','return') AND m.created_at>now()-interval '30 days'),0)::int AS sold30
      FROM products p ORDER BY p.id`);
    const t = { products: r.length, units: 0, value: 0, low: 0, out: 0, soon: 0 };
    for (const p of r) {
      p.id = +p.id; p.stock = +p.stock; p.reorder_level = +p.reorder_level; p.sold30 = +p.sold30;
      p.status = p.stock <= 0 ? 'out' : (p.stock <= p.reorder_level ? 'low' : 'ok');
      const daily = p.sold30 / 30; p.daily = Math.round(daily * 100) / 100;
      p.days_left = daily > 0 ? Math.floor(p.stock / daily) : null;
      p.soon = p.status === 'ok' && p.days_left !== null && p.days_left <= 14 && p.sold30 >= 3;
      p.need = p.status !== 'ok' || p.soon;
      p.suggest = p.need ? Math.max(1, Math.ceil(daily * 30) + p.reorder_level - p.stock) : 0;
      p.why = p.status === 'out' ? 'Out of stock' + (p.sold30 > 0 ? '. Sold ' + p.sold30 + ' in the last 30 days' : '')
        : (p.status === 'low' ? 'Low: ' + p.stock + ' left (reorder at ' + p.reorder_level + ')' + (p.sold30 > 0 ? '. Sold ' + p.sold30 + ' in 30 days' : '')
          : (p.soon ? 'Selling fast: about ' + p.days_left + ' day' + (p.days_left === 1 ? '' : 's') + ' of stock left' : ''));
      t.units += p.stock; t.value += p.stock * (p.cost ?? p.price);
      if (p.status === 'low') t.low++; else if (p.status === 'out') t.out++; else if (p.soon) t.soon++;
    }
    t.value = Math.round(t.value * 100) / 100;
    const x = await c.one("SELECT COALESCE(SUM(-qty_change),0)::int AS units,COALESCE(SUM(-qty_change*unit_price),0)::float8 AS revenue FROM stock_movements WHERE kind IN ('sale','walkin','return') AND created_at>now()-interval '30 days'");
    t.sold30 = +x.units; t.revenue30 = Math.round(num(x.revenue) * 100) / 100;
    if ((await role(c)) !== 'admin') { delete t.value; delete t.revenue30; r.forEach(p => { p.cost = null; }); }
    const rank = p => (p.status === 'out' ? 0 : (p.status === 'low' ? 1 : 2));
    const rs = r.filter(p => p.need).sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? b.sold30 - a.sold30 : (a.days_left ?? 9999) - (b.days_left ?? 9999)));
    out({ totals: t, items: r, restock: rs.slice(0, 12) });
  },

  async a_stock(c) {
    post(c); await staff(c);
    const pid = int(c.in.product_id), kind = str(c, 'kind'), n = int(c.in.qty), note = str(c, 'note'), me = await uid(c);
    if (!['restock', 'walkin', 'damaged', 'adjust'].includes(kind)) out({ error: 'Choose what happened to the stock.' }, 422);
    if (kind === 'adjust' ? n < 0 : n < 1) out({ error: kind === 'adjust' ? 'Enter the counted stock (0 or more).' : 'Enter a quantity of 1 or more.' }, 422);
    if (n > 1000000) out({ error: 'That quantity is too large.' }, 422);
    let result;
    await c.tx(async () => {
      const p = await c.one('SELECT name,price,stock FROM products WHERE id=? FOR UPDATE', [pid]);
      if (!p) out({ error: 'Unknown product.' }, 404);
      const old = +p.stock, chg = kind === 'restock' ? n : (kind === 'adjust' ? n - old : -n), nw = old + chg;
      if (nw < 0) out({ error: 'Only ' + old + ' in stock, so you can’t remove ' + n + '.' }, 409);
      if (chg === 0) { result = { stock: old, unchanged: true }; return; }
      await c.run('UPDATE products SET stock=? WHERE id=?', [nw, pid]);
      await mv(c, pid, p.name, kind, chg, nw, kind === 'walkin' ? num(p.price) : null, null, note, me);
      result = { stock: nw };
    });
    out(result);
  },

  async a_reorder(c) {
    post(c); await admin(c);
    const n = await c.exec('UPDATE products SET reorder_level=? WHERE id=?', [Math.max(0, Math.min(1000000, int(c.in.level))), int(c.in.id)]);
    if (n !== 1) out({ error: 'Unknown product.' }, 404); out({ ok: true });
  },

  async a_movements(c) {
    await staff(c);
    const pid = int(c.get('product_id'));
    out(await c.all("SELECT m.id,m.product_id,m.name,m.kind,m.qty_change,m.qty_after,m.unit_price::float8 AS unit_price,m.order_id,m.note,to_char(m.created_at,'YYYY-MM-DD HH24:MI') AS at FROM stock_movements m WHERE (?::int=0 OR m.product_id=?::int) ORDER BY m.id DESC LIMIT 100", [pid, pid]));
  },

  // =============== workers ===============
  async w_list(c) {
    await admin(c);
    out(await c.all(`SELECT u.id,u.email,u.name,u.phone,u.active,u.must_change,(u.password_hash='') AS pending,to_char(u.last_login,'YYYY-MM-DD HH24:MI') AS last_login,to_char(u.created_at,'YYYY-MM-DD') AS created,
      (SELECT COUNT(*)::int FROM orders o WHERE o.assigned_to=u.id AND o.status IN('pending','confirmed','dispatched')) AS open_orders,
      (SELECT COUNT(*)::int FROM orders o WHERE o.assigned_to=u.id AND o.status='delivered') AS delivered FROM users u WHERE u.role='worker' ORDER BY u.id`));
  },
  async w_save(c) {
    post(c); await admin(c);
    let id = int(c.in.id); const n = mbSub(str(c, 'name'), 0, 80), e = str(c, 'email').toLowerCase(), ph = mbSub(str(c, 'phone'), 0, 40);
    if (n === '' || !isEmail(e)) out({ error: 'Enter the worker’s name and a valid email.' }, 422);
    try {
      if (id) { if ((await c.exec("UPDATE users SET name=?,email=?,phone=? WHERE id=? AND role='worker'", [n, e, ph, id])) !== 1) out({ error: 'Unknown worker.' }, 404); }
      else id = +(await c.val("INSERT INTO users(email,name,phone,password_hash,role,must_change) VALUES(?,?,?,'','worker',false) RETURNING id", [e, n, ph]));
    } catch (x) { if (!isUnique(x)) throw x; out({ error: 'That email already has an account.' }, 409); }
    out({ ok: true, id });
  },
  async w_active(c) { post(c); await admin(c); if ((await c.exec("UPDATE users SET active=? WHERE id=? AND role='worker'", [!!c.in.active, int(c.in.id)])) !== 1) out({ error: 'Unknown worker.' }, 404); out({ ok: true }); },
  async w_reset(c) {
    post(c); await admin(c); const pw = String(c.in.password ?? ''); newPw(pw);
    if ((await c.exec("UPDATE users SET password_hash=?,must_change=true WHERE id=? AND role='worker'", [await hashPw(pw), int(c.in.id)])) !== 1) out({ error: 'Unknown worker.' }, 404); out({ ok: true });
  },
  async w_delete(c) { post(c); await admin(c); if ((await c.exec("DELETE FROM users WHERE id=? AND role='worker'", [int(c.in.id)])) !== 1) out({ error: 'Unknown worker.' }, 404); out({ ok: true }); },

  // =============== customers ===============
  async c_list(c) {
    await admin(c);
    out(await c.all("SELECT u.id,u.email,u.name,u.phone,u.active,to_char(u.last_login,'YYYY-MM-DD HH24:MI') AS last_login,to_char(u.created_at,'YYYY-MM-DD') AS created,(SELECT COUNT(*)::int FROM orders o WHERE o.user_id=u.id) AS orders,(SELECT COALESCE(SUM(total),0)::float8 FROM orders o WHERE o.user_id=u.id AND o.status<>'cancelled') AS spent FROM users u WHERE u.role='customer' ORDER BY u.id DESC LIMIT 1000"));
  },
  async c_save(c) {
    post(c); await admin(c);
    const id = int(c.in.id), n = mbSub(str(c, 'name'), 0, 80), e = str(c, 'email').toLowerCase(), ph = mbSub(str(c, 'phone'), 0, 40);
    if (n === '' || !isEmail(e)) out({ error: 'Enter a name and a valid email.' }, 422);
    let k; try { k = await c.exec("UPDATE users SET name=?,email=?,phone=? WHERE id=? AND role='customer'", [n, e, ph, id]); } catch (x) { if (!isUnique(x)) throw x; out({ error: 'That email already has an account.' }, 409); }
    if (k !== 1) out({ error: 'Unknown customer.' }, 404); out({ ok: true });
  },
  async c_active(c) { post(c); await admin(c); if ((await c.exec("UPDATE users SET active=? WHERE id=? AND role='customer'", [!!c.in.active, int(c.in.id)])) !== 1) out({ error: 'Unknown customer.' }, 404); out({ ok: true }); },
  async c_reset(c) {
    post(c); await admin(c); const pw = String(c.in.password ?? ''); newPw(pw);
    if ((await c.exec("UPDATE users SET password_hash=?,must_change=false WHERE id=? AND role='customer'", [await hashPw(pw), int(c.in.id)])) !== 1) out({ error: 'Unknown customer.' }, 404); out({ ok: true });
  },
  async c_delete(c) { post(c); await admin(c); if ((await c.exec("DELETE FROM users WHERE id=? AND role='customer'", [int(c.in.id)])) !== 1) out({ error: 'Unknown customer.' }, 404); out({ ok: true }); },

  // =============== admins ===============
  async ad_list(c) { await admin(c); out(await c.all("SELECT id,email,name,phone,active,to_char(last_login,'YYYY-MM-DD HH24:MI') AS last_login,to_char(created_at,'YYYY-MM-DD') AS created FROM users WHERE role='admin' ORDER BY id")); },
  async ad_save(c) {
    post(c); await admin(c);
    let id = int(c.in.id); const n = mbSub(str(c, 'name'), 0, 80), e = str(c, 'email').toLowerCase(), ph = mbSub(str(c, 'phone'), 0, 40), pw = String(c.in.password ?? '');
    if (n === '' || !isEmail(e)) out({ error: 'Enter a name and a valid email.' }, 422);
    try {
      if (id) {
        if ((await c.exec("UPDATE users SET name=?,email=?,phone=? WHERE id=? AND role='admin'", [n, e, ph, id])) !== 1) out({ error: 'Unknown admin.' }, 404);
        if (pw !== '') { newPw(pw); await c.run("UPDATE users SET password_hash=? WHERE id=? AND role='admin'", [await hashPw(pw), id]); }
      } else { newPw(pw); id = +(await c.val("INSERT INTO users(email,name,phone,password_hash,role) VALUES(?,?,?,?,'admin') RETURNING id", [e, n, ph, await hashPw(pw)])); }
    } catch (x) { if (!isUnique(x)) throw x; out({ error: 'That email already has an account.' }, 409); }
    out({ ok: true, id });
  },
  async ad_active(c) {
    post(c); await admin(c); const id = int(c.in.id), on = !!c.in.active;
    if (!on && id === (await uid(c))) out({ error: 'You can’t switch off your own account.' }, 409);
    if (!on && +(await c.val("SELECT COUNT(*) FROM users WHERE role='admin' AND active")) <= 1) out({ error: 'At least one admin must stay active.' }, 409);
    if ((await c.exec("UPDATE users SET active=? WHERE id=? AND role='admin'", [on, id])) !== 1) out({ error: 'Unknown admin.' }, 404); out({ ok: true });
  },
  async ad_delete(c) {
    post(c); await admin(c); const id = int(c.in.id);
    if (id === (await uid(c))) out({ error: 'You can’t delete your own account.' }, 409);
    if (+(await c.val("SELECT COUNT(*) FROM users WHERE role='admin' AND active")) <= 1) out({ error: 'At least one admin must stay.' }, 409);
    if ((await c.exec("DELETE FROM users WHERE id=? AND role='admin'", [id])) !== 1) out({ error: 'Unknown admin.' }, 404); out({ ok: true });
  },
};
