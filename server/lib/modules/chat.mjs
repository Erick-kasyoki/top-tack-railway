// Staff live chat: port of app/modules/chat/ChatController.php. Only signed-in admins and workers, and only with other active staff accounts.
// Every query is limited to conversations the signed-in person is part of. "Clear chat" hides older messages from the person who cleared it only.
// Attachments are stored on the volume in DATA_DIR/chat_files (never served directly); only the sender and the recipient can download them through ch_file.
import fs from 'node:fs';
import path from 'node:path';
import { out, rawOut, post, int, mbSub, rnd, uid, meRow, staff, sniffImage } from '../core.mjs';
import { DATA_DIR } from '../store.mjs';

const FILES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', txt: 'text/plain' };
const MAXFILE = 5 * 1024 * 1024;
const DIR = path.join(DATA_DIR, 'chat_files');

async function peer(c, id) {
  const r = await c.one("SELECT id,name,role FROM users WHERE id=? AND role IN('admin','worker') AND active=1 AND password_hash<>'' AND id<>?", [id, await uid(c)]);
  if (!r) out({ error: 'Choose someone from the list.' }, 404);
  return { id: +r.id, name: r.name, role: r.role };
}
const cleared = async (c, me, p) => +((await c.val('SELECT upto FROM chat_clears WHERE user_id=? AND peer_id=?', [me, p])) || 0);
// SQL for "the newest message id I cleared with the person in column col" (me is an integer, so it is safe to inline)
const clrSql = (me, col) => `COALESCE((SELECT upto FROM chat_clears c WHERE c.user_id=${me} AND c.peer_id=${col}),0)`;

// Validates and stores an uploaded attachment; returns [path,name,type,size].
async function saveFile(f) {
  if (f.size > MAXFILE) out({ error: 'Files can be up to 5 MB.' }, 422);
  let name = String(f.name || '').replace(/[\x00-\x1f\x7f\\/:*?"<>|]+/g, '_').trim();
  if (name === '' || name === '.') name = 'file';
  if (Array.from(name).length > 100) { const e = path.extname(name); name = Array.from(path.basename(name, e)).slice(0, 90).join('') + e; }
  const ext = path.extname(name).slice(1).toLowerCase(), type = FILES[ext] || null;
  if (!type) out({ error: 'That file type is not allowed. Use an image, PDF, Word, Excel, CSV or text file.' }, 422);
  const buf = Buffer.from(await f.arrayBuffer());
  if (type.startsWith('image/') && !sniffImage(buf)) out({ error: 'That image could not be read.' }, 422);
  fs.mkdirSync(DIR, { recursive: true });
  const p = rnd(16) + '.' + ext; fs.writeFileSync(path.join(DIR, p), buf);
  return [p, name, type, buf.length];
}

export const routes = {
  // everyone you can chat with, with unread counts and the last message
  async ch_users(c) {
    await staff(c); const me = await uid(c), cl = clrSql(me, 'u.id');
    const pair = `((m.sender_id=u.id AND m.recipient_id=${me}) OR (m.sender_id=${me} AND m.recipient_id=u.id)) AND m.id>${cl}`;
    const rows = await c.all(`SELECT u.id,u.name,u.role,
      (SELECT COUNT(*) FROM chat_messages m WHERE m.sender_id=u.id AND m.recipient_id=${me} AND m.read_at IS NULL AND m.id>${cl}) AS unread,
      (SELECT m.body FROM chat_messages m WHERE ${pair} ORDER BY m.id DESC LIMIT 1) AS "last",
      (SELECT m.id FROM chat_messages m WHERE ${pair} ORDER BY m.id DESC LIMIT 1) AS last_id,
      (SELECT (m.file_path IS NOT NULL) FROM chat_messages m WHERE ${pair} ORDER BY m.id DESC LIMIT 1) AS last_file
      FROM users u WHERE u.role IN('admin','worker') AND u.active=1 AND u.password_hash<>'' AND u.id<>${me} ORDER BY last_id DESC NULLS LAST,u.name`);
    out({ me, me_name: String((await meRow(c))?.name ?? ''), users: rows.map(x => ({ id: +x.id, name: x.name, role: x.role, unread: +x.unread, last: mbSub(x.last ?? '', 0, 60), last_file: !!x.last_file })) });
  },

  // the conversation with ?with=ID; ?after=ID returns only newer messages; incoming messages are marked read.
  // read_upto = newest of MY messages the other person has read (for the double ticks)
  async ch_msgs(c) {
    await staff(c); const me = await uid(c), p = await peer(c, int(c.get('with'))), after = int(c.get('after')), clr = await cleared(c, me, p.id), from = Math.max(after, clr);
    let r = (await c.all(`SELECT m.id,m.sender_id,m.body,m.reply_to,r.body AS rbody,r.sender_id AS rsender,m.file_name,m.file_type,m.file_size,to_char(m.created_at,'YYYY-MM-DD HH24:MI') AS at
      FROM chat_messages m LEFT JOIN chat_messages r ON r.id=m.reply_to
      WHERE m.id>? AND ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?)) ORDER BY m.id DESC LIMIT 200`, [from, me, p.id, p.id, me])).reverse();
    const mine = await meRow(c), myRole = mine?.role || '', pRole = p.role;
    const starter = +((await c.val('SELECT sender_id FROM chat_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?) ORDER BY id ASC LIMIT 1', [me, p.id, p.id, me])) || 0);
    r = r.map(x => {
      const isMine = +x.sender_id === me, rid = int(x.reply_to);
      const o = { id: +x.id, body: x.body, at: x.at, mine: isMine,
        reply: rid && rid > clr && x.rbody !== null ? { id: rid, body: mbSub(x.rbody, 0, 140), mine: +x.rsender === me } : null,
        file: x.file_name !== null ? { name: x.file_name, size: +x.file_size, img: String(x.file_type || '').startsWith('image/') } : null };
      // bubble colour: worker -> admin = red, admin -> worker = green; between two people of the same role the one who started the chat is orange and the other one's replies are green
      const sRole = isMine ? myRole : pRole, rRole = isMine ? pRole : myRole;
      if (sRole === 'worker' && rRole === 'admin') o.c = 'red';
      else if (sRole === 'admin' && rRole === 'worker') o.c = 'green';
      else o.c = (isMine ? me : p.id) === starter ? 'orange' : 'green';
      return o;
    });
    await c.run('UPDATE chat_messages SET read_at=now() WHERE sender_id=? AND recipient_id=? AND read_at IS NULL', [p.id, me]);
    const upto = +(await c.val('SELECT COALESCE(MAX(id),0) FROM chat_messages WHERE sender_id=? AND recipient_id=? AND read_at IS NOT NULL', [me, p.id]));
    out({ with: p, me: { id: me, name: String(mine?.name ?? ''), role: myRole }, messages: r, read_upto: upto });
  },

  // JSON {to,body,reply_to}, or multipart with the same fields plus a "file" attachment
  async ch_send(c) {
    await staff(c); const me = await uid(c);
    const multi = String(c.req.headers.get('content-type') || '').toLowerCase().startsWith('multipart/form-data');
    let inp = c.in, f = null;
    if (multi) {
      if (c.method !== 'POST' || c.req.headers.get('x-requested-with') !== 'fetch') out({ error: 'Upload with POST required.' }, 405);
      let fd; try { fd = await c.req.formData(); } catch (e) { out({ error: 'That file is bigger than the server allows.' }, 422); }
      inp = {}; for (const [k, v] of fd.entries()) if (typeof v === 'string') inp[k] = v;
      const x = fd.get('file'); f = x && typeof x !== 'string' && x.size ? x : null;
    } else post(c);
    const p = await peer(c, int(inp.to)); let b = String(inp.body ?? '').trim();
    if (b === '' && !f) out({ error: 'Type a message first.' }, 422);
    if (Array.from(b).length > 2000) out({ error: 'Messages can be up to 2000 characters.' }, 422);
    if (!f) { // the same text sent twice within 3 seconds (double click) is stored once
      const dup = await c.val("SELECT id FROM chat_messages WHERE sender_id=? AND recipient_id=? AND body=? AND created_at>now()-interval '3 seconds' ORDER BY id DESC LIMIT 1", [me, p.id, b]);
      if (dup) out({ id: +dup, duplicate: true });
    }
    let rt = int(inp.reply_to);
    if (rt && !(await c.val('SELECT id FROM chat_messages WHERE id=? AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))', [rt, me, p.id, p.id, me]))) rt = 0;
    const cols = ['sender_id', 'recipient_id', 'body', 'reply_to'], vals = [me, p.id, b, rt || null];
    if (f) { const [fp, fn, ft, fs_] = await saveFile(f); if (b === '') vals[2] = fn; cols.push('file_path', 'file_name', 'file_type', 'file_size'); vals.push(fp, fn, ft, fs_); }
    await c.run(`INSERT INTO chat_messages(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`, vals);
    out({ id: +(await c.val('SELECT last_insert_rowid()')) });
  },

  // ?id=MESSAGE_ID, optional &dl=1: streams an attachment, only to the two people in that conversation
  async ch_file(c) {
    await staff(c); const me = await uid(c);
    const m = await c.one('SELECT file_path,file_name,file_type FROM chat_messages WHERE id=? AND file_path IS NOT NULL AND (sender_id=? OR recipient_id=?)', [int(c.get('id')), me, me]);
    const fp = m ? path.join(DIR, path.basename(String(m.file_path))) : '';
    if (!m || !fs.existsSync(fp)) out({ error: 'File not found.' }, 404);
    const img = String(m.file_type || '').startsWith('image/') && !c.get('dl'), buf = fs.readFileSync(fp);
    const ascii = String(m.file_name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '\\$&');
    rawOut(buf, { 'Content-Type': img ? m.file_type : 'application/octet-stream', 'Content-Length': String(buf.length),
      'Content-Disposition': `${img ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(m.file_name)}`,
      'Cache-Control': 'private, max-age=86400', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox" });
  },

  // clear the conversation with {to:ID} from MY side only
  async ch_clear(c) {
    post(c); await staff(c); const me = await uid(c), p = await peer(c, int(c.in.to));
    const max = +(await c.val('SELECT COALESCE(MAX(id),0) FROM chat_messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)', [me, p.id, p.id, me]));
    await c.run('INSERT INTO chat_clears(user_id,peer_id,upto) VALUES(?,?,?) ON CONFLICT(user_id,peer_id) DO UPDATE SET upto=MAX(chat_clears.upto,EXCLUDED.upto)', [me, p.id, max]);
    await c.run('UPDATE chat_messages SET read_at=now() WHERE sender_id=? AND recipient_id=? AND read_at IS NULL', [p.id, me]);
    out({ ok: true });
  },

  // total unread, for the badge on the chat button
  async ch_unread(c) {
    await staff(c); const me = await uid(c);
    out({ unread: +(await c.val(`SELECT COUNT(*) FROM chat_messages m WHERE m.recipient_id=${me} AND m.read_at IS NULL AND m.id>${clrSql(me, 'm.sender_id')}`)) });
  },
};
