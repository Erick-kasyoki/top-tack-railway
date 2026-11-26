// Shared helpers for the billing modules (invoices, quotations, expenses, leave): port of app/invoice_lib.php and the helpers in app/modules_lib.php.
import { cfg, mailList, mailSend, later, numberFormat, num } from './core.mjs';

export class Bad extends Error {}                                   // PHP InvalidArgumentException: a message the admin can read
export const FREQ = ['weekly', 'monthly', 'quarterly', 'yearly'];
export const PAY_METHODS = ['Cash', 'Bank transfer', 'Mobile money', 'Card', 'Cheque', 'Other'];
export const cents = v => Math.round(num(v) * 100);
export const moneyStr = c => (c / 100).toFixed(2);
export const nf = (n, d = 2) => numberFormat(n, d);
const pad = n => String(n).padStart(2, '0');
export const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// date + (interval * n), counted from the start date, so a monthly invoice started on the 31st doesn't drift (same as PostgreSQL).
export function addFreq(s, freq, n) {
  if (freq === 'weekly') return addDays(s, 7 * n);
  const [y, m, d] = s.split('-').map(Number), step = { monthly: 1, quarterly: 3, yearly: 12 }[freq] || 1;
  const t = y * 12 + (m - 1) + step * n, ny = Math.floor(t / 12), nm = t % 12, last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${pad(nm + 1)}-${pad(Math.min(d, last))}`;
}
export const fmtDate = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace(/,/g, '');
const esc = s => String(s).replace(/[\\%_]/g, m => '\\' + m);
// SQLite has no sequences: the next number is the highest existing number with this prefix plus one (INV-0001, QUO-0001 ...).
export async function nextNo(c, table, prefix, width = 4) {
  const n = await c.val(`SELECT COALESCE(MAX(CAST(SUBSTR(number,?) AS INTEGER)),0)+1 FROM ${table} WHERE number LIKE ? ESCAPE '\\'`, [prefix.length + 1, esc(prefix) + '%']);
  return prefix + String(+n).padStart(width, '0');
}
// Email to the shop's order address(es): only when SMTP is set up in Admin > Settings, and never holds up the request.
export const adminMail = c => mailList(cfg(c, 'ORDER_EMAIL', ''));
export function mhMail(c, to, subject, body) {
  if (!to || !to.length || String(cfg(c, 'SMTP_HOST', '')).trim() === '') return;
  later(c, async () => { try { await mailSend(c, to, subject, body); } catch (e) { console.error('mail:', e.message); } });
}
export const NUM = v => (v === null || v === undefined ? 0 : Number(v) || 0);
