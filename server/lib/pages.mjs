// Public, branded invoice and quotation pages: port of app/invoice.php and app/quote.php. Opened with the private link /invoice.php?t=TOKEN or /quote.php?t=TOKEN.
// Add &print=1 to open the print dialog straight away (choose "Save as PDF" as the printer).
import { cfg } from './core.mjs';
import { invLoad } from './modules/invoices.mjs';
import { qtLoad } from './modules/quotes.mjs';
import { nf } from './helpers.mjs';

const CSS_INV = "*{box-sizing:border-box}\nbody{margin:0;background:#eef0f3;color:var(--tx);font:14px/1.45 system-ui,-apple-system,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n.bar{max-width:820px;margin:16px auto 0;padding:0 16px;display:flex;gap:10px;justify-content:flex-end}\n.bar button,.bar a{border:0;border-radius:999px;padding:10px 20px;font:inherit;font-weight:700;background:var(--brand);color:var(--on);cursor:pointer;text-decoration:none}\n.bar a.alt{background:#fff;color:#222;border:1px solid var(--bd)}\n.sheet{position:relative;max-width:820px;margin:16px auto;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.12);overflow:hidden}\n.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:28px 36px;background:var(--brand);color:var(--on)}\n.top img{max-height:64px;max-width:200px;display:block;margin-bottom:8px;background:#fff;border-radius:6px;padding:4px}\n.top h1{margin:0;font-size:24px;letter-spacing:-.3px}.top small{display:block;opacity:.9;margin-top:2px}\n.top .ti{text-align:right}.top .ti b{display:block;font-size:30px;letter-spacing:2px}\n.body{padding:28px 36px 36px}\n.cols{display:flex;flex-wrap:wrap;gap:24px 40px;justify-content:space-between;margin-bottom:24px}\n.cols h2{margin:0 0 4px;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--mu)}\n.cols p{margin:0;white-space:pre-line}\ntable{width:100%;border-collapse:collapse}\nth{background:var(--brand);color:var(--on);text-align:left;padding:9px 10px;font-size:12px;letter-spacing:.4px}\ntd{padding:10px;border-bottom:1px solid var(--bd);vertical-align:top}\n.n{text-align:right;white-space:nowrap}\n.tot{width:min(340px,100%);margin:18px 0 0 auto}\n.tot div{display:flex;justify-content:space-between;padding:5px 10px}\n.tot .g{font-weight:800;font-size:16px;border-top:2px solid var(--brand);margin-top:4px;padding-top:9px}\n.tot .due{background:var(--brand);color:var(--on);font-weight:800;font-size:17px;border-radius:6px;margin-top:8px;padding:10px}\n.sec{margin-top:26px}.sec h2{margin:0 0 6px;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--mu)}\n.sec p{margin:0;white-space:pre-line}\n.pay td{padding:6px 10px;font-size:13px}\n.sum{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px 24px}\n.sum .tot{margin:18px 0 0 auto}\n.stamp{align-self:center;margin:26px 0 0 12px;transform:rotate(-8deg);border:4px solid #999;color:#999;font-weight:900;font-size:32px;letter-spacing:3px;padding:2px 16px;border-radius:8px;opacity:.6;white-space:nowrap}\n.stamp.ok{border-color:#1b8a3a;color:#1b8a3a}.stamp.bad{border-color:#c4161c;color:#c4161c}\n.foot{margin-top:32px;padding-top:12px;border-top:1px solid var(--bd);color:var(--mu);font-size:12px;text-align:center}\n@media(max-width:620px){.top,.body{padding-left:18px;padding-right:18px}.top{flex-direction:column}.top .ti{text-align:left}.stamp{font-size:24px;margin-top:8px}.ow{overflow-x:auto}}\n@media print{@page{size:A4;margin:0}body{background:#fff}.bar{display:none}.sheet{margin:0;max-width:none;box-shadow:none}tr{break-inside:avoid}}\n";
const CSS_QT = "*{box-sizing:border-box}\nbody{margin:0;background:#eef0f3;color:var(--tx);font:14px/1.45 system-ui,-apple-system,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}\n.bar{max-width:820px;margin:16px auto 0;padding:0 16px;display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap}\n.bar button,.bar a{border:0;border-radius:999px;padding:10px 20px;font:inherit;font-weight:700;background:var(--brand);color:var(--on);cursor:pointer;text-decoration:none}\n.bar a.alt,.bar button.alt{background:#fff;color:#222;border:1px solid var(--bd)}\n.sheet{position:relative;max-width:820px;margin:16px auto;background:#fff;box-shadow:0 2px 14px rgba(0,0,0,.12);overflow:hidden}\n.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding:28px 36px;background:var(--brand);color:var(--on)}\n.top img{max-height:64px;max-width:200px;display:block;margin-bottom:8px;background:#fff;border-radius:6px;padding:4px}\n.top h1{margin:0;font-size:24px;letter-spacing:-.3px}.top small{display:block;opacity:.9;margin-top:2px}\n.top .ti{text-align:right}.top .ti b{display:block;font-size:28px;letter-spacing:2px}\n.body{padding:28px 36px 36px}\n.cols{display:flex;flex-wrap:wrap;gap:24px 40px;justify-content:space-between;margin-bottom:24px}\n.cols h2,.sec h2{margin:0 0 4px;font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:var(--mu)}\n.cols p,.sec p{margin:0;white-space:pre-line}\n.subj{font-size:16px;font-weight:700;margin:0 0 16px}\ntable{width:100%;border-collapse:collapse}\nth{background:var(--brand);color:var(--on);text-align:left;padding:9px 10px;font-size:12px;letter-spacing:.4px}\ntd{padding:10px;border-bottom:1px solid var(--bd);vertical-align:top}\n.n{text-align:right;white-space:nowrap}\n.tot{width:min(340px,100%);margin:18px 0 0 auto}\n.tot div{display:flex;justify-content:space-between;padding:5px 10px}\n.tot .g{font-weight:800;font-size:17px;background:var(--brand);color:var(--on);border-radius:6px;margin-top:6px;padding:10px}\n.sec{margin-top:24px}\n.sum{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px 24px}\n.stamp{align-self:center;margin:26px 0 0 12px;transform:rotate(-8deg);border:4px solid #999;color:#999;font-weight:900;font-size:30px;letter-spacing:3px;padding:2px 16px;border-radius:8px;opacity:.6;white-space:nowrap}\n.stamp.ok{border-color:#1b8a3a;color:#1b8a3a}.stamp.bad{border-color:#c4161c;color:#c4161c}\n.ans{margin-top:26px;padding:16px;border:2px dashed var(--brand);border-radius:10px;text-align:center}\n.ans p{margin:0 0 10px;font-weight:600}.ans button{border:0;border-radius:999px;padding:11px 24px;font:inherit;font-weight:800;cursor:pointer;margin:4px}\n.ans .yes{background:#1b8a3a;color:#fff}.ans .no{background:#fff;color:#c4161c;border:1px solid #c4161c}\n.ans .msg{margin-top:8px;font-weight:700}\n.foot{margin-top:30px;padding-top:12px;border-top:1px solid var(--bd);color:var(--mu);font-size:12px;text-align:center}\n@media(max-width:620px){.top,.body{padding-left:18px;padding-right:18px}.top{flex-direction:column}.top .ti{text-align:left}.stamp{font-size:22px;margin-top:8px}.ow{overflow-x:auto}}\n@media print{@page{size:A4;margin:0}body{background:#fff}.bar,.ans{display:none}.sheet{margin:0;max-width:none;box-shadow:none}tr{break-inside:avoid}}\n";
const h = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const dfmt = s => { const d = new Date(s + 'T12:00:00Z'); return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const qty = n => String(+Number(n).toFixed(2));
const NOT_FOUND = what => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${what} not found</title><body style="font:16px system-ui;max-width:480px;margin:15vh auto;padding:0 16px"><h1>${what} not found</h1><p>This link is not valid. Please ask us for a new one.</p>`;

function head(c, title, css) {
  let brand = String(cfg(c, 'BRAND_COLOR', '#12385f')); if (!/^#[0-9a-f]{6}$/i.test(brand)) brand = '#12385f';
  const [r, g, b] = [1, 3, 5].map(i => parseInt(brand.slice(i, i + 2), 16)), on = (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#1a1a1a' : '#ffffff';
  let logo = String(cfg(c, 'LOGO', 'img/logo.png')); if (!/^(https?:\/\/\S+|[\w./-]+)$/.test(logo)) logo = '';
  return { logo, html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="icon" type="image/png" href="img/favicon.png?v=3"><link rel="shortcut icon" href="favicon.ico?v=3"><link rel="apple-touch-icon" href="img/apple-touch-icon.png?v=3">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${h(title)} · ${h(cfg(c, 'SITE_NAME', 'Store'))}</title>
<style>
:root{--brand:${h(brand)};--on:${h(on)};--tx:#222;--mu:#666;--bd:#ddd}
${css}</style></head><body>` };
}
const logoHtml = logo => (logo ? `<img src="${h(logo)}" alt="" onerror="this.remove()">` : '');
const printJs = c => (c.get('print') ? '<script>addEventListener("load",()=>setTimeout(()=>print(),400))</script>' : '');
const itemRows = (items, m, line) => items.map(i => `<tr><td>${h(i.description)}</td><td class="n">${h(qty(i.qty))}</td><td class="n">${h(m(i.unit_price))}</td><td class="n">${h(m(line(i)))}</td></tr>`).join('\n');
const lines = (o, keys) => keys.filter(k => o[k] !== '').map(k => '\n' + h(o[k])).join('');

export async function invoicePage(c) {
  const t = c.get('t'), inv = /^[a-f0-9]{32}$/.test(t) ? await invLoad(c, 'x.token=?', t) : null;
  if (!inv) return [404, NOT_FOUND('Invoice')];
  const cur = cfg(c, 'CURRENCY', '$'), m = n => cur + nf(n), taxName = cfg(c, 'TAX_NAME', 'Tax');
  const stamp = { draft: 'DRAFT', void: 'VOID', paid: 'PAID', overdue: 'OVERDUE', partial: 'PART PAID', unpaid: '' }[inv.pstatus] ?? '';
  const stampClass = inv.pstatus === 'paid' ? 'ok' : ['overdue', 'void'].includes(inv.pstatus) ? 'bad' : '';
  const line = i => Math.round(i.qty * i.unit_price * 100) / 100;
  const { logo, html } = head(c, 'Invoice ' + inv.number, CSS_INV);
  const info = [cfg(c, 'SITE_ADDRESS', ''), cfg(c, 'SITE_PHONE', ''), cfg(c, 'SITE_EMAIL', '')].filter(x => x !== '').map(x => `<small>${h(x)}</small>`).join('');
  return [200, html + `
<div class="bar"><a class="alt" href="./">Back to store</a><button type="button" onclick="window.print()">Download PDF / Print</button></div>
<main class="sheet">
<div class="top">
 <div>${logoHtml(logo)}
  <h1>${h(cfg(c, 'SITE_NAME', 'Store'))}</h1>
  ${info}
 </div>
 <div class="ti"><b>INVOICE</b><small>${h(inv.number)}</small></div>
</div>
<div class="body">
 <div class="cols">
  <div><h2>Bill to</h2><p><b>${h(inv.customer_name)}</b>${lines(inv, ['customer_address', 'customer_phone', 'customer_email'])}</p></div>
  <div><h2>Issued</h2><p>${h(dfmt(inv.issue_date))}</p></div>
  <div><h2>Due</h2><p>${h(dfmt(inv.due_date))}</p></div>
  ${inv.order_id ? `<div><h2>Order</h2><p>#${+inv.order_id}</p></div>` : ''}
 </div>
 <div class="ow"><table>
  <tr><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr>
  ${itemRows(inv.items, m, line)}
 </table></div>
 <div class="sum">
 ${stamp ? `<div class="stamp ${stampClass}">${h(stamp)}</div>` : ''}
 <div class="tot">
  <div><span>Subtotal</span><span>${h(m(inv.subtotal))}</span></div>
  ${inv.discount > 0 ? `<div><span>Discount</span><span>−${h(m(inv.discount))}</span></div>` : ''}
  ${inv.tax_rate > 0 ? `<div><span>${h(taxName)} (${h(qty(inv.tax_rate))}%)</span><span>${h(m(inv.tax))}</span></div>` : ''}
  <div class="g"><span>Total</span><span>${h(m(inv.total))}</span></div>
  ${inv.paid > 0 ? `<div><span>Paid</span><span>−${h(m(inv.paid))}</span></div>` : ''}
  ${inv.status === 'sent' || inv.status === 'draft' ? `<div class="due"><span>Balance due</span><span>${h(m(inv.balance))}</span></div>` : ''}
 </div>
 </div>
 ${inv.payments.length ? `<div class="sec"><h2>Payments received</h2><table class="pay">
  ${inv.payments.map(p => `<tr><td>${h(dfmt(p.paid_on))}</td><td>${h(p.method)}${p.note !== '' ? ' · ' + h(p.note) : ''}</td><td class="n">${h(m(p.amount))}</td></tr>`).join('')}
 </table></div>` : ''}
 ${inv.notes !== '' ? `<div class="sec"><h2>Notes</h2><p>${h(inv.notes)}</p></div>` : ''}
 ${cfg(c, 'PAY_INFO', '') !== '' && inv.status !== 'void' && inv.balance > 0 ? `<div class="sec"><h2>How to pay</h2><p>${h(cfg(c, 'PAY_INFO', ''))}</p></div>` : ''}
 <div class="foot">Thank you for your business.</div>
</div>
</main>
${printJs(c)}
</body></html>`];
}

export async function quotePage(c) {
  const t = c.get('t'), q = /^[a-f0-9]{32}$/.test(t) ? await qtLoad(c, 'q.token=?', t) : null;
  if (!q) return [404, NOT_FOUND('Quotation')];
  const cur = cfg(c, 'CURRENCY', '$'), m = n => cur + nf(n), taxName = cfg(c, 'TAX_NAME', 'Tax'), qs = q.qstatus;
  const stamp = { request: 'REQUESTED', draft: 'DRAFT', void: 'VOID', accepted: 'ACCEPTED', declined: 'DECLINED', expired: 'EXPIRED', sent: '' }[qs] ?? '';
  const stampClass = qs === 'accepted' ? 'ok' : ['declined', 'void', 'expired'].includes(qs) ? 'bad' : '';
  const line = i => Math.round(i.qty * i.unit_price * 100) / 100, phones = [cfg(c, 'SITE_PHONE', ''), cfg(c, 'SITE_PHONE2', '')].filter(Boolean), canAnswer = qs === 'sent';
  const { logo, html } = head(c, 'Quotation ' + q.number, CSS_QT);
  const info = [cfg(c, 'SITE_ADDRESS', ''), ...phones, cfg(c, 'SITE_EMAIL', '')].filter(x => x !== '').map(x => `<small>${h(x)}</small>`).join('');
  return [200, html + `
<div class="bar"><a class="alt" href="./">Back to store</a><button type="button" onclick="window.print()">Download PDF / Print</button></div>
<main class="sheet">
<div class="top">
 <div>${logoHtml(logo)}
  <h1>${h(cfg(c, 'SITE_NAME', 'Store'))}</h1>
  ${info}
 </div>
 <div class="ti"><b>QUOTATION</b><small>${h(q.number)}</small></div>
</div>
<div class="body">
 <div class="cols">
  <div><h2>Prepared for</h2><p><b>${h(q.customer_name)}</b>${lines(q, ['customer_company', 'customer_address', 'customer_phone', 'customer_email'])}</p></div>
  <div><h2>Date</h2><p>${h(dfmt(q.issue_date))}</p></div>
  <div><h2>Valid until</h2><p>${h(dfmt(q.valid_until))}</p></div>
 </div>
 ${q.subject !== '' ? `<p class="subj">${h(q.subject)}</p>` : ''}
 ${!q.items.length ? `<div class="sec"><h2>Your request</h2><p>${h(q.request_text)}</p><p style="margin-top:10px;color:var(--mu)">We are preparing your quotation and will contact you shortly.</p></div>` : `
 <div class="ow"><table>
  <tr><th>Description</th><th class="n">Qty</th><th class="n">Unit price</th><th class="n">Amount</th></tr>
  ${itemRows(q.items, m, line)}
 </table></div>
 <div class="sum">
  ${stamp ? `<div class="stamp ${stampClass}">${h(stamp)}</div>` : ''}
  <div class="tot">
   <div><span>Subtotal</span><span>${h(m(q.subtotal))}</span></div>
   ${q.discount > 0 ? `<div><span>Discount</span><span>−${h(m(q.discount))}</span></div>` : ''}
   ${q.tax_rate > 0 ? `<div><span>${h(taxName)} (${h(qty(q.tax_rate))}%)</span><span>${h(m(q.tax))}</span></div>` : ''}
   <div class="g"><span>Total</span><span>${h(m(q.total))}</span></div>
  </div>
 </div>`}
 ${q.notes !== '' ? `<div class="sec"><h2>Notes</h2><p>${h(q.notes)}</p></div>` : ''}
 ${q.terms !== '' ? `<div class="sec"><h2>Terms &amp; conditions</h2><p>${h(q.terms)}</p></div>` : ''}
 ${canAnswer ? `<div class="ans" id="ans"><p>Happy with this quotation? Let us know:</p>
  <button class="yes" data-d="accepted">Accept quotation</button><button class="no" data-d="declined">Decline</button><div class="msg" id="msg"></div></div>` : ''}
 <div class="foot">Questions? Call ${h(phones.join(' or ') || cfg(c, 'SITE_EMAIL', 'us'))}. Thank you for considering ${h(cfg(c, 'SITE_NAME', 'us'))}.</div>
</div>
</main>
${canAnswer ? `<script>
document.getElementById('ans').addEventListener('click',async ev=>{
 const b=ev.target.closest('button[data-d]');if(!b)return;
 if(b.dataset.d==='declined'&&!confirm('Decline this quotation?'))return;
 const msg=document.getElementById('msg');msg.textContent='Sending…';
 try{const r=await fetch('api.php?action=q_respond',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(q.token)},decision:b.dataset.d})});
  const j=await r.json();if(!r.ok)throw new Error(j.error||'Something went wrong.');
  msg.textContent=b.dataset.d==='accepted'?'Thank you! We will contact you to confirm the order.':'Noted. Thank you for letting us know.';
  document.querySelectorAll('#ans button').forEach(x=>x.hidden=true);
 }catch(x){msg.textContent=x.message}
});
</script>` : ''}
${printJs(c)}
</body></html>`];
}
