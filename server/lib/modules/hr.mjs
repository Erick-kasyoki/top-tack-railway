// Expense Tracker (admin only) and Employee Leave Management: port of app/modules_lib.php.
// Employees are the worker accounts. Workers request leave on worker.html, the admin approves on admin.html.
import { out, rawOut, post, str, int, num, mbSub, cfg, cx, inum, csvCell, validDate, todayStr, uid, meRow, need, admin, nfAdd, nfMoney, numberFormat } from '../core.mjs';
import { PAY_METHODS, addDays, addFreq, fmtDate, mhMail, adminMail } from '../helpers.mjs';
import { mailList } from '../core.mjs';

const isFk = x => x && x.code === '23503', isUnique = x => x && x.code === '23505';
const month = (c, s) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || '')) ? String(s) : todayStr(c).slice(0, 7));
const fmt1 = x => String(parseFloat(Number(x).toFixed(1)));
const plural = n => (n === 1 ? '' : 's');

export const routes = {
  // =============== EXPENSE TRACKER (admin only) ===============
  async x_list(c) {
    await admin(c);
    const m = month(c, c.get('month')), from = m + '-01', to = addFreq(from, 'monthly', 1), first = addFreq(from, 'monthly', -5);
    const cats = (await c.all('SELECT id,name,budget FROM expense_categories ORDER BY name')).map(r => ({ id: +r.id, name: r.name, budget: Number(r.budget) }));
    const sp = {}; for (const r of await c.all('SELECT category,SUM(amount) AS spent,COUNT(*) AS n FROM expenses WHERE spent_on>=? AND spent_on<? GROUP BY category', [from, to])) sp[r.category] = r;
    let total = 0, budget = 0;
    for (const k of cats) { k.spent = Number(sp[k.name]?.spent ?? 0); k.n = +(sp[k.name]?.n ?? 0); total += k.spent; budget += k.budget; }
    const items = (await c.all('SELECT e.id,e.spent_on,e.category,e.description,e.vendor,e.amount,e.method,e.reference,u.name AS by_name FROM expenses e LEFT JOIN users u ON u.id=e.user_id WHERE e.spent_on>=? AND e.spent_on<? ORDER BY e.spent_on DESC,e.id DESC', [from, to]))
      .map(i => ({ ...i, id: +i.id, amount: Number(i.amount) }));
    // Six-month trend: expenses against sales (online sales, in-store sales, minus cancelled orders), by shop-local month
    const ex = {}; for (const r of await c.all('SELECT substr(spent_on,1,7) AS mo,SUM(amount) AS v FROM expenses WHERE spent_on>=? AND spent_on<? GROUP BY 1', [first, to])) ex[r.mo] = Number(r.v);
    const sa = {}; for (const r of await c.all("SELECT to_char(created_at,'YYYY-MM') AS mo,COALESCE(SUM(-qty_change*unit_price),0) AS v FROM stock_movements WHERE kind IN('sale','walkin','return') AND unit_price IS NOT NULL AND to_char(created_at,'YYYY-MM-DD')>=? AND to_char(created_at,'YYYY-MM-DD')<? GROUP BY 1", [first, to])) sa[r.mo] = Number(r.v);
    const trend = []; for (let k = 5; k >= 0; k--) { const mo = addFreq(from, 'monthly', -k).slice(0, 7); trend.push({ month: mo, expenses: ex[mo] ?? 0, sales: sa[mo] ?? 0 }); }
    out({ month: m, categories: cats, items, total, budget, sales: trend[trend.length - 1].sales, trend, methods: PAY_METHODS, today: todayStr(c) });
  },
  async x_save(c) {
    post(c); await admin(c); const inp = c.in, id = int(inp.id);
    const d = str(c, 'spent_on'); if (!validDate(d)) out({ error: 'Enter a valid date.' }, 422);
    const cat = mbSub(str(c, 'category'), 0, 60); if (cat === '') out({ error: 'Choose a category.' }, 422);
    const a = inum(inp.amount ?? ''); if (!a || a <= 0 || a > 999999999) out({ error: 'Enter an amount greater than zero.' }, 422);
    let meth = str(c, 'method'); if (!PAY_METHODS.includes(meth)) meth = 'Other';
    const desc = mbSub(str(c, 'description'), 0, 200), ven = mbSub(str(c, 'vendor'), 0, 120), ref = mbSub(str(c, 'reference'), 0, 80), amt = a.toFixed(2);
    try {
      if (id) {
        if (!(await c.exec('UPDATE expenses SET spent_on=?,category=?,description=?,vendor=?,amount=?,method=?,reference=? WHERE id=?', [d, cat, desc, ven, amt, meth, ref, id]))) out({ error: 'That expense no longer exists.' }, 404);
      } else {
        await c.run('INSERT INTO expenses(spent_on,category,description,vendor,amount,method,reference,user_id) VALUES(?,?,?,?,?,?,?,?)', [d, cat, desc, ven, amt, meth, ref, await uid(c)]);
        await nfAdd(c, 'admin', null, 'expense_new', 'Expense recorded: ' + nfMoney(c, a), cat + (desc !== '' ? ' · ' + desc : ''), 'tab:x');
      }
    } catch (x) { if (isFk(x)) out({ error: 'Choose one of the listed categories.' }, 422); throw x; }
    out({ ok: true });
  },
  async x_delete(c) { post(c); await admin(c); await c.run('DELETE FROM expenses WHERE id=?', [int(c.in.id)]); out({ ok: true }); },
  async x_cat_save(c) {
    post(c); await admin(c); const inp = c.in, id = int(inp.id), n = mbSub(str(c, 'name'), 0, 60);
    if (n === '') out({ error: 'Enter a category name.' }, 422);
    const b = (inp.budget ?? '') === '' ? 0 : inum(inp.budget);
    if (b === false || b === null || b < 0 || b > 999999999) out({ error: 'The budget must be a number, or 0 for no budget.' }, 422);
    try {
      if (id) { if (!(await c.exec('UPDATE expense_categories SET name=?,budget=? WHERE id=?', [n, b.toFixed(2), id]))) out({ error: 'Category not found.' }, 404); } // renaming updates its expenses too
      else await c.run('INSERT INTO expense_categories(name,budget) VALUES(?,?)', [n, b.toFixed(2)]);
    } catch (x) { if (isUnique(x)) out({ error: 'There is already a category with that name.' }, 409); throw x; }
    out({ ok: true });
  },
  async x_cat_delete(c) {
    post(c); await admin(c);
    try { await c.run('DELETE FROM expense_categories WHERE id=?', [int(c.in.id)]); }
    catch (x) { if (isFk(x)) out({ error: 'This category has expenses. Move or delete them first, or just rename it.' }, 409); throw x; }
    out({ ok: true });
  },
  async x_export(c) {
    await admin(c);
    const all = c.get('month') === 'all', m = month(c, c.get('month')), from = m + '-01', to = addFreq(from, 'monthly', 1);
    const rows = await c.all('SELECT spent_on,category,description,vendor,amount,method,reference FROM expenses' + (all ? '' : ' WHERE spent_on>=? AND spent_on<?') + ' ORDER BY spent_on,id', all ? [] : [from, to]);
    let body = '\uFEFF' + ['date', 'category', 'description', 'vendor', 'amount', 'method', 'reference'].join(',') + '\r\n';
    for (const r of rows) body += [r.spent_on, cx(r.category), cx(r.description), cx(r.vendor), Number(r.amount).toFixed(2), cx(r.method), cx(r.reference)].map(csvCell).join(',') + '\r\n';
    rawOut(body, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="expenses-${all ? 'all' : m}.csv"` });
  },

  // =============== EMPLOYEE LEAVE ===============
  async lv_mine(c) {
    await need(c, ['worker']);
    const u = await uid(c), today = todayStr(c), y = today.slice(0, 4), types = [];
    for (const t of await c.all('SELECT id,name,days_per_year,paid FROM leave_types WHERE active=1 ORDER BY id')) {
      const id = +t.id, allow = +t.days_per_year, used = await used_(c, u, id, y, ['approved']), pend = await used_(c, u, id, y, ['pending']);
      types.push({ id, name: t.name, allowance: allow, paid: !!t.paid, used, pending: pend, left: allow > 0 ? Math.max(0, allow - used - pend) : null });
    }
    const rows = (await c.all('SELECT r.id,t.name AS type,r.start_date,r.end_date,r.days,r.reason,r.status,r.decision_note FROM leave_requests r JOIN leave_types t ON t.id=r.type_id WHERE r.user_id=? ORDER BY r.start_date DESC,r.id DESC LIMIT 60', [u]))
      .map(r => ({ ...lrow(r), can_cancel: r.status === 'pending' || (r.status === 'approved' && r.start_date > today) }));
    out({ year: y, today, off_days: offdays(c), types, requests: rows });
  },
  async lv_request(c) {
    post(c); await need(c, ['worker']); const inp = c.in, u = await uid(c), a = str(c, 'start'), b = str(c, 'end'), tid = int(inp.type_id), why = mbSub(str(c, 'reason'), 0, 300);
    const days = await leaveCheck(c, u, tid, a, b, false);
    await c.run('INSERT INTO leave_requests(user_id,type_id,start_date,end_date,days,reason) VALUES(?,?,?,?,?,?)', [u, tid, a, b, days, why]);
    const id = +(await c.val('SELECT last_insert_rowid()')), me = await meRow(c), tn = await c.val('SELECT name FROM leave_types WHERE id=?', [tid]);
    await nfAdd(c, 'admin', null, 'leave_new', 'Leave request from ' + me.name, `${fmtDate(a)} to ${fmtDate(b)} (${days} working day${plural(days)})`, 'tab:l');
    mhMail(c, adminMail(c), 'Leave request from ' + me.name, `${me.name} asked for ${tn}: ${fmtDate(a)} to ${fmtDate(b)} (${days} working day(s)).\r\n` + (why !== '' ? `Reason: ${why}\r\n` : '') + '\r\nApprove or reject it in Admin > Leave.\r\n');
    out({ ok: true, id, days });
  },
  async lv_cancel(c) {
    post(c); await need(c, ['worker']);
    if (!(await c.exec("UPDATE leave_requests SET status='cancelled' WHERE id=? AND user_id=? AND (status='pending' OR (status='approved' AND start_date>?))", [int(c.in.id), await uid(c), todayStr(c)])))
      out({ error: 'This request can no longer be cancelled. Leave that has started must be changed by the admin.' }, 409);
    out({ ok: true });
  },
  async lv_count(c) { await admin(c); out({ pending: +(await c.val("SELECT COUNT(*) FROM leave_requests WHERE status='pending'")) }); },
  async lv_admin(c) {
    await admin(c);
    const today = todayStr(c), y = today.slice(0, 4);
    const types = (await c.all('SELECT id,name,days_per_year,paid,active FROM leave_types ORDER BY id')).map(t => ({ id: +t.id, name: t.name, days_per_year: +t.days_per_year, paid: !!t.paid, active: !!t.active }));
    const workers = (await c.all("SELECT id,name FROM users WHERE role='worker' AND active=1 ORDER BY name")).map(w => ({ id: +w.id, name: w.name }));
    const used = {}; for (const r of await c.all("SELECT user_id,type_id,SUM(days) AS d FROM leave_requests WHERE status='approved' AND start_date>=? AND start_date<=? GROUP BY user_id,type_id", [y + '-01-01', y + '-12-31'])) (used[+r.user_id] ||= {})[+r.type_id] = Number(r.d);
    const bal = {}; for (const w of workers) for (const t of types) if (t.active) (bal[w.id] ||= {})[t.id] = used[w.id]?.[t.id] ?? 0;
    const sel = "SELECT r.id,r.user_id,u.name AS employee,t.name AS type,t.id AS type_id,t.days_per_year,r.start_date,r.end_date,r.days,r.reason,r.status,r.decision_note,to_char(r.created_at,'YYYY-MM-DD') AS asked FROM leave_requests r JOIN users u ON u.id=r.user_id JOIN leave_types t ON t.id=r.type_id";
    const map = r => { const x = { ...lrow(r), employee: r.employee, user_id: +r.user_id, asked: r.asked }, al = +r.days_per_year; x.left = al > 0 ? Math.max(0, al - (used[+r.user_id]?.[+r.type_id] ?? 0)) : null; return x; };
    const pending = (await c.all(sel + " WHERE r.status='pending' ORDER BY r.start_date,r.id")).map(map);
    const st = c.get('status', 'all'), fu = int(c.get('user_id')), w = [], p = [];
    if (['pending', 'approved', 'rejected', 'cancelled'].includes(st)) { w.push('r.status=?'); p.push(st); }
    if (fu) { w.push('r.user_id=?'); p.push(fu); }
    const hist = (await c.all(sel + (w.length ? ' WHERE ' + w.join(' AND ') : '') + ' ORDER BY r.start_date DESC,r.id DESC LIMIT 200', p)).map(map);
    const away = (await c.all("SELECT r.id,u.name AS employee,t.name AS type,r.start_date,r.end_date,r.days FROM leave_requests r JOIN users u ON u.id=r.user_id JOIN leave_types t ON t.id=r.type_id WHERE r.status='approved' AND r.end_date>=? AND r.start_date<=? ORDER BY r.start_date,u.name", [today, addDays(today, 60)]))
      .map(a => ({ ...a, id: +a.id, days: Number(a.days), now: a.start_date <= today }));
    out({ year: y, today, off_days: offdays(c), types, workers, balances: bal, pending, history: hist, away });
  },
  async lv_decide(c) {
    post(c); await admin(c); const inp = c.in, id = int(inp.id), dec = str(c, 'decision'), note = mbSub(str(c, 'note'), 0, 300);
    if (!['approve', 'reject'].includes(dec)) out({ error: 'Choose approve or reject.' }, 422);
    let r; const me = await uid(c);
    await c.tx(async () => {
      r = await c.one('SELECT r.id,r.user_id,r.type_id,r.start_date,r.end_date,r.days,r.status,t.name AS tname,t.days_per_year FROM leave_requests r JOIN leave_types t ON t.id=r.type_id WHERE r.id=?', [id]);
      if (!r) out({ error: 'Request not found.' }, 404);
      if (r.status !== 'pending') out({ error: 'This request was already ' + r.status + '.' }, 409);
      if (dec === 'approve') {
        const allow = +r.days_per_year;
        if (allow > 0) {
          const left = allow - await used_(c, +r.user_id, +r.type_id, r.start_date.slice(0, 4), ['approved'], id);
          if (Number(r.days) > left + 0.001) out({ error: 'Only ' + fmt1(Math.max(0, left)) + ' day(s) of ' + r.tname + ' are left for this person. Raise the allowance in Leave types, or reject.' }, 422);
        }
      }
      await c.run("UPDATE leave_requests SET status=?,decided_by=?,decided_at=now(),decision_note=? WHERE id=?", [dec === 'approve' ? 'approved' : 'rejected', me, note, id]);
    });
    const word = dec === 'approve' ? 'approved' : 'rejected';
    await nfAdd(c, '', +r.user_id, 'mine_leave', `Your ${r.tname} request was ${word}`, `${fmtDate(r.start_date)} to ${fmtDate(r.end_date)}` + (note !== '' ? ' · ' + note : ''), 'tab:l');
    const emp = await c.one('SELECT email,name FROM users WHERE id=?', [+r.user_id]);
    if (emp) mhMail(c, mailList(emp.email), 'Your leave request was ' + word, `Hello ${emp.name},\r\n\r\nYour ${r.tname} request (${fmtDate(r.start_date)} to ${fmtDate(r.end_date)}) was ${word}.\r\n` + (note !== '' ? `Note from the admin: ${note}\r\n` : ''));
    out({ ok: true });
  },
  // The admin records leave for an employee (for example sick leave taken or leave agreed in person). It is approved straight away.
  async lv_admin_add(c) {
    post(c); await admin(c); const inp = c.in, u = int(inp.user_id), tid = int(inp.type_id), a = str(c, 'start'), b = str(c, 'end'), why = mbSub(str(c, 'reason'), 0, 300);
    if (!(await c.val("SELECT 1 FROM users WHERE id=? AND role='worker' AND active=1", [u]))) out({ error: 'Choose an employee.' }, 422);
    const days = await leaveCheck(c, u, tid, a, b, true);
    await c.run("INSERT INTO leave_requests(user_id,type_id,start_date,end_date,days,reason,status,decided_by,decided_at) VALUES(?,?,?,?,?,?,'approved',?,now())", [u, tid, a, b, days, why, await uid(c)]);
    out({ ok: true, days });
  },
  async lv_admin_cancel(c) {
    post(c); await admin(c);
    if (!(await c.exec("UPDATE leave_requests SET status='cancelled',decided_by=?,decided_at=now() WHERE id=? AND status IN('pending','approved')", [await uid(c), int(c.in.id)]))) out({ error: 'Nothing to cancel.' }, 409);
    out({ ok: true });
  },
  async lv_type_save(c) {
    post(c); await admin(c); const inp = c.in, id = int(inp.id), n = mbSub(str(c, 'name'), 0, 60);
    if (n === '') out({ error: 'Enter a name for the leave type.' }, 422);
    const d = (inp.days_per_year ?? '') === '' ? 0 : inp.days_per_year;
    if (isNaN(Number(d)) || Number(d) < 0 || Number(d) > 365 || Math.floor(Number(d)) !== Number(d)) out({ error: 'Days per year must be a whole number from 0 to 365 (0 means no limit).' }, 422);
    const paid = inp.paid ? 1 : 0, act = !('active' in inp) || inp.active ? 1 : 0;
    try {
      if (id) { if (!(await c.exec('UPDATE leave_types SET name=?,days_per_year=?,paid=?,active=? WHERE id=?', [n, int(d), paid, act, id]))) out({ error: 'Leave type not found.' }, 404); }
      else await c.run('INSERT INTO leave_types(name,days_per_year,paid,active) VALUES(?,?,?,?)', [n, int(d), paid, act]);
    } catch (x) { if (isUnique(x)) out({ error: 'There is already a leave type with that name.' }, 409); throw x; }
    out({ ok: true });
  },
  async lv_type_delete(c) {
    post(c); await admin(c);
    try { await c.run('DELETE FROM leave_types WHERE id=?', [int(c.in.id)]); }
    catch (x) { if (isFk(x)) out({ error: 'This leave type has requests. Switch it off instead of deleting it.' }, 409); throw x; }
    out({ ok: true });
  },
};

// ---------- leave helpers ----------
// Days off that do not count (default Sunday): set the LEAVE_OFF_DAYS setting, e.g. '67' for Saturday and Sunday (1=Mon ... 7=Sun).
const offdays = c => [...new Set(String(cfg(c, 'LEAVE_OFF_DAYS', '7')).replace(/\D/g, '').split('').filter(d => d >= '1' && d <= '7').map(Number))];
function workDays(c, a, b) {
  const off = offdays(c); let n = 0, d = new Date(a + 'T00:00:00Z'); const e = new Date(b + 'T00:00:00Z');
  for (let i = 0; d <= e && i < 400; i++) { if (!off.includes(((d.getUTCDay() + 6) % 7) + 1)) n++; d.setUTCDate(d.getUTCDate() + 1); }
  return n;
}
// Days of one leave type already used (or booked) by an employee in a calendar year. A request counts in the year it starts.
async function used_(c, u, type, year, statuses, skip = 0) {
  const list = statuses.filter(s => ['pending', 'approved'].includes(s)).map(s => `'${s}'`).join(',');
  return Number(await c.val(`SELECT COALESCE(SUM(days),0) FROM leave_requests WHERE user_id=? AND type_id=? AND status IN(${list}) AND start_date>=? AND start_date<=? AND id<>?`, [u, type, year + '-01-01', year + '-12-31', skip]));
}
const overlap = async (c, u, a, b, skip = 0) => !!(await c.val("SELECT 1 FROM leave_requests WHERE user_id=? AND status IN('pending','approved') AND start_date<=? AND end_date>=? AND id<>? LIMIT 1", [u, b, a, skip]));
// Validates a leave request for an employee; returns the number of days, or stops with an error.
async function leaveCheck(c, u, typeId, a, b, allowPast) {
  const t = await c.one('SELECT id,name,days_per_year FROM leave_types WHERE id=? AND active=1', [typeId]);
  if (!t) out({ error: 'Choose a leave type.' }, 422);
  if (!validDate(a) || !validDate(b)) out({ error: 'Choose the first and last day of the leave.' }, 422);
  if (b < a) out({ error: 'The last day cannot be before the first day.' }, 422);
  if (!allowPast && a < todayStr(c)) out({ error: 'The first day cannot be in the past. Ask the admin to record it.' }, 422);
  if ((Date.parse(b) - Date.parse(a)) / 86400000 > 365) out({ error: 'A single request cannot be longer than a year.' }, 422);
  const days = workDays(c, a, b);
  if (days < 1) out({ error: 'All of those dates are days off, so no leave is needed.' }, 422);
  if (await overlap(c, u, a, b)) out({ error: 'These dates overlap leave that is already requested or approved.' }, 409);
  const allow = +t.days_per_year;
  if (allow > 0) {
    const y = a.slice(0, 4), left = allow - await used_(c, u, +t.id, y, ['pending', 'approved']);
    if (days > left + 0.001) out({ error: 'Not enough ' + t.name + ' left for ' + y + ': ' + fmt1(Math.max(0, left)) + ' day(s) left, you asked for ' + days + '.' }, 422);
  }
  return days;
}
const lrow = r => ({ id: +r.id, type: r.type, start: r.start_date, end: r.end_date, days: Number(r.days), reason: r.reason, status: r.status, note: r.decision_note });
