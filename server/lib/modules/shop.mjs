// Ports of: accounts, storefront, notifications, settings (app/modules/{accounts,storefront,notifications,settings}).
import {
  out, post, str, int, num, isEmail, mbSub, money2, hashPw, verifyPw, cfg, tzList, validTz, validDate, mailList,
  meRow, uid, role, uJson, need, admin, newPw, throttle, failTry, signIn, rememberSession,
  cart, prod, mv, nfAdd, nfList, nfMoney, tillNo, mapBranches, contentGet, mailSend, notifyOrder, later,
  savePhoto, dpOk, blobDrop,
} from '../core.mjs';
import { mpesaReady } from './mpesa.mjs';

export const routes = {
  // ---------------- accounts ----------------
  async me(c) { const u = await meRow(c); out({ user: u ? uJson(u) : null, cart: await cart(c) }); },

  async register(c) {
    post(c);
    const e = str(c, 'email').toLowerCase(), pw = String(c.in.password ?? ''); let n = mbSub(str(c, 'name'), 0, 80); const ph = mbSub(str(c, 'phone'), 0, 40);
    if (!isEmail(e) || pw.length < 8) out({ error: 'Enter a valid email and a password of at least 8 characters.' }, 422);
    if (n === '') n = e.split('@')[0];
    let id;
    try { id = await c.val("INSERT INTO users(email,name,phone,password_hash,role) VALUES(?,?,?,?,'customer') RETURNING id", [e, n, ph, await hashPw(pw)]); }
    catch (x) { if (x.code !== '23505') throw x; out({ error: 'That email is already registered. Try signing in.' }, 409); }
    c.session = { uid: +id, cart: c.session.cart || {} }; rememberSession(c); c._me = undefined;
    await nfAdd(c, 'admin', null, 'user_new', 'New customer: ' + n, e, 'tab:c');
    out({ user: uJson(await meRow(c)), cart: await cart(c) });
  },

  async login(c) { post(c); const u = await signIn(c, ['customer'], 'Incorrect email or password.'); out({ user: uJson(u), cart: await cart(c) }); },

  async logout(c) { post(c); c.session = {}; c._me = null; out({ ok: true }); },

  async staff_login(c) {
    post(c);
    const portal = str(c, 'portal') === 'worker' ? 'worker' : 'admin';
    const u = await signIn(c, [portal], portal === 'admin' ? 'This account is not an admin. Workers sign in at worker.html.' : 'This account is not a worker. Admins sign in at admin.html.');
    out({ user: uJson(u) });
  },

  // Worker sign-up: only for an email the admin has already added.
  async worker_signup(c) {
    post(c);
    const e = str(c, 'email').toLowerCase(), pw = String(c.in.password ?? ''), k1 = 'ws:' + e, k2 = 'ws:' + c.ip;
    await throttle(c, k1, 5); await throttle(c, k2, 20);
    if (!isEmail(e) || pw.length < 8) out({ error: 'Enter your email and a password of at least 8 characters.' }, 422);
    const id = await c.val("UPDATE users SET password_hash=?,must_change=false,last_login=now() WHERE email=? AND role='worker' AND active AND password_hash='' RETURNING id", [await hashPw(pw), e]);
    if (!id) { await failTry(c, k1); await failTry(c, k2); out({ error: 'Sign-up is not available for this email. Ask the store admin to add you as a worker first, or sign in if you already signed up.' }, 403); }
    c.session = { uid: +id, cart: c.session.cart || {} }; rememberSession(c); c._me = undefined;
    await nfAdd(c, 'admin', null, 'worker_joined', 'Worker signed up: ' + e, 'They can now take orders.', 'tab:w');
    out({ user: uJson(await meRow(c)) });
  },

  // Admin sign-up: with no ADMIN_SIGNUP_CODE only the very first admin can sign up.
  async admin_register(c) {
    post(c);
    const k = 'a:' + c.ip; await throttle(c, k, 10);
    const code = String(cfg(c, 'ADMIN_SIGNUP_CODE', ''));
    const has = !!(await c.val("SELECT 1 FROM users WHERE role='admin' LIMIT 1"));
    if (code !== '') { if (code !== String(c.in.code ?? '')) { await failTry(c, k); out({ error: 'That admin setup code is not correct.' }, 403); } }
    else if (has) out({ error: 'Admin sign-up is closed. Ask an existing admin, or set ADMIN_SIGNUP_CODE in the Railway Variables tab.' }, 403);
    const e = str(c, 'email').toLowerCase(), pw = String(c.in.password ?? ''), n = mbSub(str(c, 'name'), 0, 80);
    if (n === '' || !isEmail(e) || pw.length < 8) out({ error: 'Enter your name, a valid email and a password of at least 8 characters.' }, 422);
    let id;
    try { id = await c.val("INSERT INTO users(email,name,password_hash,role) VALUES(?,?,?,'admin') RETURNING id", [e, n, await hashPw(pw)]); }
    catch (x) { if (x.code !== '23505') throw x; out({ error: 'That email is already registered.' }, 409); }
    c.session = { uid: +id, cart: c.session.cart || {} }; rememberSession(c); c._me = undefined;
    out({ user: uJson(await meRow(c)) });
  },

  async change_password(c) {
    post(c); await need(c, ['customer', 'worker', 'admin'], true);
    const nw = String(c.in.new ?? ''); newPw(nw);
    const h = await c.val('SELECT password_hash FROM users WHERE id=?', [await uid(c)]);
    if (!(await verifyPw(String(c.in.current ?? ''), h))) out({ error: 'Your current password is not correct.' }, 403);
    if (nw === String(c.in.current ?? '')) out({ error: 'Choose a password different from the current one.' }, 422);
    await c.run('UPDATE users SET password_hash=?,must_change=false WHERE id=?', [await hashPw(nw), await uid(c)]);
    out({ ok: true });
  },

  async u_photo(c) {
    await need(c, ['customer', 'worker', 'admin'], true);
    const me = await uid(c), old = await c.val('SELECT photo FROM users WHERE id=?', [me]);
    const path = await savePhoto(c, 'avatars');
    await c.run('UPDATE users SET photo=? WHERE id=?', [path, me]);
    if (dpOk(old)) await blobDrop(old);
    out({ ok: true, photo: path });
  },
  async u_photo_remove(c) {
    post(c); await need(c, ['customer', 'worker', 'admin'], true);
    const me = await uid(c), old = await c.val('SELECT photo FROM users WHERE id=?', [me]);
    await c.run("UPDATE users SET photo='' WHERE id=?", [me]);
    if (dpOk(old)) await blobDrop(old);
    out({ ok: true });
  },

  // ---------------- notifications ----------------
  async notifs(c) { await nfList(c); },

  // ---------------- storefront ----------------
  async site(c) {
    const has = !!(await c.val("SELECT 1 FROM users WHERE role='admin' LIMIT 1"));
    const d = (await c.all('SELECT dept FROM products GROUP BY dept ORDER BY MIN(id)')).map(r => r.dept);
    const di = {}; for (const r of await c.all("SELECT p.dept,p.image FROM products p WHERE p.image<>'' AND p.id=(SELECT q.id FROM products q WHERE q.dept=p.dept AND q.image<>'' ORDER BY (q.stock=0),q.id LIMIT 1)")) di[r.dept] = r.image;
    out({
      name: cfg(c, 'SITE_NAME', 'Store'), currency: cfg(c, 'CURRENCY', '$'), phone: cfg(c, 'SITE_PHONE', ''), content: contentGet(c), phone2: cfg(c, 'SITE_PHONE2', ''),
      address: cfg(c, 'SITE_ADDRESS', ''), quote_days: int(cfg(c, 'QUOTE_VALID_DAYS', 30)), email: cfg(c, 'SITE_EMAIL', ''), branches: mapBranches(c), depts: d, dept_images: di,
      tax_name: cfg(c, 'TAX_NAME', 'Tax'), default_tax: num(cfg(c, 'DEFAULT_TAX', 0)), due_days: int(cfg(c, 'DUE_DAYS', 14)), mpesa: mpesaReady(c),
      admin_signup: cfg(c, 'ADMIN_SIGNUP_CODE', '') !== '' ? 'code' : (has ? 'closed' : 'first'),
    });
  },

  async products(c) {
    const q = c.get('q').trim(), d = c.get('dept', 'All'), w = [], p = [];
    if (q !== '') { const l = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'; w.push('(name ILIKE ? OR dept ILIKE ? OR descr ILIKE ?)'); p.push(l, l, l); }
    if (d !== 'All') { w.push('dept=?'); p.push(d); }
    out((await c.all('SELECT id,name,descr,price,was,emoji,image,dept,stock FROM products' + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY id', p)).map(prod));
  },

  async best(c) {
    const cols = 'id,name,descr,price,was,emoji,image,dept,stock'; let L = [];
    L = await c.all(`SELECT ${cols} FROM products WHERE best_seller ORDER BY best_pos,id LIMIT 8`);
    const manual = L.length > 0;
    if (!manual) {
      L = await c.all("SELECT p.id,p.name,p.descr,p.price,p.was,p.emoji,p.image,p.dept,p.stock FROM products p JOIN (SELECT oi.product_id,SUM(oi.qty) AS n FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status<>'cancelled' AND o.created_at>now()-interval '30 days' AND oi.product_id IS NOT NULL GROUP BY oi.product_id) s ON s.product_id=p.id WHERE p.stock>0 AND p.image<>'' ORDER BY s.n DESC,p.id LIMIT 8");
      if (L.length < 8) { const have = L.map(r => r.id); for (const r of await c.all(`SELECT ${cols} FROM products WHERE stock>0 AND image<>'' ORDER BY id LIMIT 24`)) { if (L.length >= 8) break; if (!have.includes(r.id)) L.push(r); } }
    }
    out({ manual, items: L.map(prod) });
  },

  async cart(c) {
    post(c);
    const id = int(c.in.product_id), n = Math.max(0, Math.min(99, int(c.in.qty)));
    const st = await c.val('SELECT stock FROM products WHERE id=?', [id]);
    if (st === null) out({ error: 'Unknown product.' }, 404);
    if (n > +st) out({ error: 'Only ' + +st + ' in stock.' }, 409);
    c.session.cart = c.session.cart || {};
    if (n) c.session.cart[id] = n; else delete c.session.cart[id];
    out(await cart(c));
  },

  async checkout(c) {
    post(c);
    if (!(await uid(c))) out({ error: 'Please sign in to check out.' }, 401);
    const nm = str(c, 'name'), ph = str(c, 'phone'), ad = str(c, 'address'), nt = str(c, 'note'), pm = str(c, 'payment');
    const pay = pm === 'pickup' ? 'Pay on pickup' : (pm === 'mpesa' ? 'M-Pesa' : 'Cash on delivery');
    if (pm === 'mpesa' && !mpesaReady(c)) out({ error: 'M-Pesa payment is not available right now. Choose another payment option.' }, 503);
    if (nm === '' || ph.length < 7 || ad === '') out({ error: 'Enter your name, phone number and delivery address.' }, 422);
    const ct = await cart(c); if (!ct.items.length) out({ error: 'Your cart is empty.' }, 422);
    const me = await uid(c), left = {}; let oid;
    await c.tx(async () => {
      for (const r of ct.items) {
        const a = await c.val('UPDATE products SET stock=stock-? WHERE id=? AND stock>=? RETURNING stock', [r.qty, r.id, r.qty]);
        if (a === null) out({ error: r.name + ' doesn’t have enough stock. Lower the quantity and try again.' }, 409);
        left[r.id] = +a;
      }
      oid = +(await c.val('INSERT INTO orders(user_id,total,name,phone,address,note,payment) VALUES(?,?,?,?,?,?,?) RETURNING id', [me, money2(ct.total), nm, ph, ad, nt, pay]));
      for (const r of ct.items) {
        await c.run('INSERT INTO order_items(order_id,product_id,name,unit_price,qty) VALUES(?,?,?,?,?)', [oid, r.id, r.name, money2(r.price), r.qty]);
        await mv(c, r.id, r.name, 'sale', -r.qty, left[r.id], r.price, oid, 'Online order #' + oid);
      }
    });
    c.session.cart = {};
    await nfAdd(c, '', me, 'mine_order', 'Order #' + oid + ' received', 'We have your order and will confirm it shortly.', 'orders');
    await nfAdd(c, 'staff', null, 'order_new', 'New order #' + oid, nm + ' · ' + nfMoney(c, ct.total) + ' · ' + pay, 'tab:o');
    for (const r of ct.items) if ((left[r.id] ?? 1) <= 0) await nfAdd(c, 'staff', null, 'stock_out', r.name + ' is now out of stock', 'Restock it in Inventory.', 'tab:i');
    later(c, () => notifyOrder(c, oid)); // e-mail the store after the customer has their answer
    out({ order_id: oid, total: ct.total });
  },

  async orders(c) {
    const me = await uid(c); if (!me) out({ error: 'Sign in to see your orders.' }, 401);
    const rs = await c.all("SELECT o.id,(o.paid_at IS NOT NULL) AS paid,o.total::float8 AS total,o.status,to_char(o.created_at,'YYYY-MM-DD HH24:MI') AS at,extract(epoch from o.created_at)::bigint AS ts,(SELECT COALESCE(SUM(qty),0)::int FROM order_items WHERE order_id=o.id) AS items FROM orders o WHERE o.user_id=? ORDER BY o.id DESC LIMIT 20", [me]);
    const tn = tillNo(c), mp = mpesaReady(c);
    out(rs.map(x => ({ ...x, paid: !!x.paid, till: tn, pay_due: tn !== '' && x.status === 'confirmed' && !x.paid, mpesa_due: mp && !x.paid && ['pending', 'confirmed'].includes(x.status) })));
  },

  // ---------------- settings ----------------
  async a_settings(c) {
    await admin(c);
    const keys = ['MAP_BRANCHES', 'SITE_NAME', 'SITE_PHONE', 'SITE_PHONE2', 'SITE_EMAIL', 'SITE_ADDRESS', 'CURRENCY', 'QUOTE_PREFIX', 'QUOTE_VALID_DAYS', 'QUOTE_TERMS', 'TAX_NAME', 'DEFAULT_TAX', 'DUE_DAYS', 'INVOICE_PREFIX', 'BRAND_COLOR', 'LOGO', 'PAY_INFO', 'TILL_NUMBER', 'ORDER_EMAIL', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'MAIL_FROM', 'BH_TZ', 'BH_START', 'BH_END', 'BH_WARN', 'BH_TARGET', 'BH_DAYS', 'BH_HOLIDAYS'];
    const r = {}; for (const k of keys) r[k] = String(cfg(c, k, '')); r.SMTP_PASS_SET = String(cfg(c, 'SMTP_PASS', '')) !== '' ? '1' : ''; out(r);
  },

  async a_settings_save(c) {
    post(c); await admin(c);
    const I = c.in, oldTill = tillNo(c);
    const rules = { MAP_BRANCHES: 1500, SITE_NAME: 80, SITE_PHONE: 40, SITE_PHONE2: 40, SITE_EMAIL: 120, SITE_ADDRESS: 300, CURRENCY: 8, QUOTE_PREFIX: 12, QUOTE_VALID_DAYS: 3, QUOTE_TERMS: 1500, TAX_NAME: 20, DEFAULT_TAX: 8, DUE_DAYS: 4, INVOICE_PREFIX: 12, BRAND_COLOR: 7, LOGO: 300, PAY_INFO: 600, TILL_NUMBER: 12, ORDER_EMAIL: 300, SMTP_HOST: 120, SMTP_PORT: 5, SMTP_SECURE: 4, SMTP_USER: 120, SMTP_PASS: 200, MAIL_FROM: 120, BH_TZ: 64, BH_START: 5, BH_END: 5, BH_WARN: 3, BH_TARGET: 5, BH_DAYS: 13, BH_HOLIDAYS: 2000 };
    const has = k => k in I && I[k] !== null && I[k] !== undefined;
    if (has('ORDER_EMAIL') && String(I.ORDER_EMAIL).trim() !== '' && mailList(I.ORDER_EMAIL).length !== String(I.ORDER_EMAIL).trim().split(/[,;\s]+/).filter(Boolean).length) out({ error: 'One of the order email addresses is not valid.' }, 422);
    if (has('TILL_NUMBER') && String(I.TILL_NUMBER).trim() !== '' && !/^\d{4,10}$/.test(String(I.TILL_NUMBER).trim())) out({ error: 'The till number must be 4 to 10 digits.' }, 422);
    if (has('SMTP_SECURE') && !['tls', 'ssl', 'none'].includes(I.SMTP_SECURE)) out({ error: 'Security must be TLS, SSL or None.' }, 422);
    if (has('SMTP_PORT') && I.SMTP_PORT !== '' && !/^\d+$/.test(String(I.SMTP_PORT))) out({ error: 'The SMTP port must be a number.' }, 422);
    if (has('BH_TZ') && !validTz(I.BH_TZ)) out({ error: 'Choose a valid timezone.' }, 422);
    for (const k of ['BH_START', 'BH_END']) if (has(k) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(I[k])) out({ error: 'Start and end time must look like 08:00.' }, 422);
    if (has('BH_START') && has('BH_END') && I.BH_END <= I.BH_START) out({ error: 'The daily end time must be after the start time.' }, 422);
    if (has('BH_WARN') && (!/^\d+$/.test(String(I.BH_WARN)) || +I.BH_WARN < 1 || +I.BH_WARN > 100)) out({ error: 'Breach warning must be a whole number from 1 to 100.' }, 422);
    if (has('BH_TARGET') && I.BH_TARGET !== '' && (isNaN(I.BH_TARGET) || +I.BH_TARGET < 0 || +I.BH_TARGET > 720)) out({ error: 'The order target must be 0 to 720 working hours (0 switches it off).' }, 422);
    if (has('BH_DAYS')) { const d = String(I.BH_DAYS).split(',').filter(Boolean); for (const x of d) if (!/^[1-7]$/.test(x)) out({ error: 'Working days are not valid.' }, 422); if (!d.length) out({ error: 'Choose at least one working day.' }, 422); I.BH_DAYS = [...new Set(d)].join(','); }
    if (has('BH_HOLIDAYS')) { const h = new Set(); for (const x of String(I.BH_HOLIDAYS).trim().split(/[,;\s]+/).filter(Boolean)) { if (!validDate(x)) out({ error: 'Holiday “' + x + '” must look like 2026-12-25.' }, 422); h.add(x); } I.BH_HOLIDAYS = [...h].sort().join(','); }
    if (!has('BH_TZ') && String(I.SITE_NAME ?? '').trim() === '') out({ error: 'The store name can’t be empty.' }, 422);
    if (has('MAP_BRANCHES') && String(I.MAP_BRANCHES).trim() !== '') { let n = 0; for (const ln of String(I.MAP_BRANCHES).trim().split(/\r?\n/)) { if (ln.trim() === '') continue; const p = ln.split('|').map(x => x.trim()); n++; if (p.length < 4 || p[0] === '' || isNaN(p[2]) || isNaN(p[3]) || Math.abs(p[2]) > 90 || Math.abs(p[3]) > 180) out({ error: 'Map branch line ' + n + ' must look like: Name | Address | -1.2833 | 36.8167' }, 422); } }
    if (has('BRAND_COLOR') && I.BRAND_COLOR !== '' && !/^#[0-9a-f]{6}$/i.test(I.BRAND_COLOR)) out({ error: 'Colour must look like #12385f.' }, 422);
    if (has('LOGO') && I.LOGO !== '' && !/^(https?:\/\/\S+|[\w./-]+)$/.test(I.LOGO)) out({ error: 'Logo must be a photo path like img/logo.png or a web address.' }, 422);
    for (const k of ['DEFAULT_TAX', 'DUE_DAYS', 'QUOTE_VALID_DAYS']) if (has(k) && I[k] !== '' && isNaN(I[k])) out({ error: k + ' must be a number.' }, 422);
    await c.tx(async () => {
      for (const [k, len] of Object.entries(rules)) if (has(k) && !(k === 'SMTP_PASS' && String(I[k]).trim() === ''))
        await c.run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v', [k, mbSub(String(I[k]).trim(), 0, len)]);
    });
    const nt = String(I.TILL_NUMBER ?? '').trim();
    if (nt !== '' && nt !== oldTill) for (const o of await c.all("SELECT id,user_id,total FROM orders WHERE status='confirmed' AND paid_at IS NULL AND user_id IS NOT NULL"))
      await nfAdd(c, '', +o.user_id, 'mine_pay', 'Order #' + o.id + ': please pay ' + nfMoney(c, o.total) + ' to Till Number ' + nt, 'M-PESA > Lipa na M-PESA > Buy Goods and Services. We dispatch your order once payment is confirmed.', 'orders');
    out({ ok: true });
  },

  async a_mail_test(c) {
    post(c); await admin(c);
    const to = mailList(cfg(c, 'ORDER_EMAIL', '')); if (!to.length) out({ error: 'Enter the email address that should receive orders first.' }, 422);
    try { await mailSend(c, to, 'Test email from ' + cfg(c, 'SITE_NAME', 'your store'), 'This is a test. If you can read it, new orders will reach this address.\r\n'); }
    catch (x) { out({ error: 'Could not send: ' + x.message }, 502); }
    out({ ok: true, to: to.join(', ') });
  },
};
