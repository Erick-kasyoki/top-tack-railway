// The database: SQLite (sql.js, runs inside the Node process) saved as one file on disk.
// On Railway, mount a Volume at /data so the file survives deploys and restarts.
import initSqlJs from 'sql.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA } from './schema.mjs';

export const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve('data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'top-tack.sqlite');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let SQL, version = 0, cache = null; // cache = bytes of the file as last read/written by this process
export class Conflict extends Error { constructor() { super('db conflict'); } }

// Loads the database (creates it with the tables and sample products the first time).
export async function openDb() {
  SQL ||= await initSqlJs();
  if (!cache && fs.existsSync(DB_FILE)) cache = fs.readFileSync(DB_FILE);
  let db, fresh = false;
  if (cache) db = new SQL.Database(new Uint8Array(cache));
  else { db = new SQL.Database(); db.exec(SCHEMA); fresh = true; }
  db.exec('PRAGMA foreign_keys=ON');
  return { db, etag: version, fresh };
}

// Saves atomically (temp file + rename). Requests are run one at a time by server.mjs, so conflicts should not happen.
export async function saveDb(c) {
  if (c._etag !== undefined && c._etag !== null && c._etag !== version) throw new Conflict();
  const bytes = Buffer.from(c._db.export());
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, DB_FILE);
  cache = bytes; version++;
}

// Cookie-signing secret: SESSION_SECRET if set, otherwise a random one kept in the data folder.
let SECRET;
export async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (SECRET) return SECRET;
  const f = path.join(DATA_DIR, 'session-secret');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch (e) {}
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
  return SECRET;
}
