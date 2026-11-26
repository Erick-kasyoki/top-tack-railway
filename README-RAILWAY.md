# Top Tack Safety Shop on Railway (everything in one service)

One Node server serves the pages (`public/`), the API (`/api.php`), and uploaded photos.
The database is a SQLite file and photos are files, both stored on a **Railway Volume**. No outside database, no Netlify.

## Deploy
1. Push this folder to a GitHub repo.
2. Railway > **New Project > Deploy from GitHub repo**. Build and start are set by `railway.json` (`npm start`).
3. In the service: **Settings > Volumes > Add Volume**, mount path `/data`. **Do this before real use**, or data is lost on each deploy.
4. **Variables**: add `DATA_DIR=/data`, `SESSION_SECRET=<long random text>`; optional `ADMIN_SIGNUP_CODE`, `SITE_URL` (your domain).
5. **Settings > Networking > Generate Domain** (or add your custom domain).
6. Open `/setup` once (creates the database), then `/admin.html` > **Create admin account**.
7. Admin > Settings > Order emails: fill in SMTP so order emails work.

## Notes
- Keep the service at **1 replica** (SQLite file on one volume).
- Backup: Railway volume backups, or Admin product export. Photos are in `/data/uploads`.
- Health check: `/health`. Local run: `npm install && npm start` (data goes to `./data`).
- **Everything from the PHP version is now ported**: Sales/POS (`sales.mjs`), Invoices + recurring (`invoices.mjs`), Quotations (`quotes.mjs`), Expenses + Leave (`hr.mjs`), staff Chat with attachments (`chat.mjs`), M-Pesa STK Push (`mpesa.mjs`), and the public `/invoice.php?t=` and `/quote.php?t=` pages (`pages.mjs`).
- Receipt, invoice and quotation numbers use the highest existing number plus one (SQLite has no sequences). Prefixes: `SALE_PREFIX`, `INVOICE_PREFIX`, `QUOTE_PREFIX` settings.
- Recurring invoices are created whenever an admin opens the Invoices tab (as in the PHP version, there is no separate cron job).
- Chat attachments are stored in `/data/chat_files` and only the two people in the chat can download them.

## M-Pesa (optional)
Add these Railway Variables; until all are set the M-Pesa option stays hidden:
`MPESA_ENV` (`sandbox` or `live`), `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_PASSKEY`, `MPESA_CALLBACK_SECRET` (32+ random characters), and `SITE_URL` (your https domain; defaults to the Railway domain).
Optional: `MPESA_TXN_TYPE` (`CustomerBuyGoodsOnline` for a till, `CustomerPayBillOnline` for a paybill), `MPESA_PARTYB`.
Safaricom calls back to `SITE_URL/api.php?action=m_callback&k=<MPESA_CALLBACK_SECRET>`.
