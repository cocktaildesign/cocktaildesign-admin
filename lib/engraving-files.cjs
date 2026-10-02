'use strict';

// Private, independent storage. Never opens the shop database or contacts the CRM.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const MAX_FILE = 10 * 1024 * 1024;
const MAX_FILES = 3;
const DAY = 86400000;
const TOKEN = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
class UploadError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new UploadError(code, status); };

function filename(value) {
  if (typeof value !== 'string' || value.length > 120 || !value.trim() || /[\x00-\x1f\x7f\\/:<>"|?*]/.test(value)) fail('invalid_filename');
  const ext = path.extname(value).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.pdf', '.svg'].includes(ext)) fail('unsupported_file');
  return value;
}

async function validateFile(buffer, name) {
  const ext = path.extname(filename(name)).toLowerCase();
  if (!buffer.length || buffer.length > MAX_FILE) fail('file_too_large', 413);
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    if (ext === '.png' ? !png : !jpeg) fail('invalid_file');
    try {
      const image = require('sharp')(buffer, { limitInputPixels: 16_000_000, failOn: 'warning' });
      const meta = await image.metadata();
      if (!meta.width || !meta.height || (meta.pages || 1) !== 1) fail('invalid_file');
      // Decode to verify structure, but retain the original file for the engraver.
      await image.resize(1, 1).raw().toBuffer();
    } catch { fail('invalid_file'); }
  } else if (ext === '.pdf') {
    if (!/^%PDF-1\.[0-9]/.test(buffer.subarray(0, 8).toString('ascii')) || !buffer.subarray(-2048).includes(Buffer.from('%%EOF'))) fail('invalid_file');
    // Never render PDFs on the server or inline in the shop. This is not an antivirus.
  } else {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { fail('invalid_file'); }
    const { SaxesParser } = require('saxes');
    const parser = new SaxesParser({ xmlns: true });
    let elements = 0, depth = 0;
    const elementsAllowed = new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','defs','clipPath','mask','linearGradient','radialGradient','stop','title','desc','text','tspan','use']);
    parser.on('doctype', () => fail('unsafe_svg'));
    parser.on('processinginstruction', () => fail('unsafe_svg'));
    parser.on('error', () => fail('invalid_file'));
    parser.on('opentag', tag => {
      if (++elements > 20000 || ++depth > 80 || !elementsAllowed.has(tag.local) || tag.uri !== 'http://www.w3.org/2000/svg' || (elements === 1 && tag.local !== 'svg')) fail('unsafe_svg');
      for (const attr of Object.values(tag.attributes)) {
        if (attr.prefix === 'xmlns' || attr.name === 'xmlns') continue;
        if (/^on/i.test(attr.local) || ['style','base'].includes(attr.local) || (attr.prefix && attr.prefix !== 'xlink')) fail('unsafe_svg');
        if (attr.local === 'href' && !/^#[A-Za-z0-9_.:-]+$/.test(attr.value)) fail('unsafe_svg');
        // Paint server references must be internal fragment IDs; never load remote resources.
        if (/url\s*\(/i.test(attr.value) && !/^url\(#[A-Za-z0-9_.:-]+\)$/.test(attr.value)) fail('unsafe_svg');
        if (/[\\\x00-\x08]|javascript:|data:|https?:|\/\//i.test(attr.value)) fail('unsafe_svg');
      }
    });
    parser.on('closetag', () => { depth--; });
    parser.write(source).close();
    if (!elements || depth !== 0) fail('invalid_file');
  }
}

class EngravingStorage {
  constructor(directory, options = {}) {
    if (!path.isAbsolute(directory)) throw Error('Engraving directory must be absolute');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Engraving directory cannot be a symlink');
    this.root = fs.realpathSync(directory);
    this.blobs = path.join(this.root, 'blobs');
    fs.mkdirSync(this.blobs, { mode: 0o700, recursive: true });
    if (fs.lstatSync(this.blobs).isSymbolicLink()) throw Error('Blob directory cannot be a symlink');
    this.maxBytes = options.maxBytes ?? 1024 ** 3;
    this.minFree = options.minFree ?? 12 * 1024 ** 3;
    this.now = options.now ?? Date.now;
    this.free = options.free ?? (() => { const s = fs.statfsSync(this.root); return s.bavail * s.bsize; });
    const Database = require('better-sqlite3');
    this.db = new Database(path.join(this.root, 'metadata.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL,
      created INTEGER NOT NULL, state TEXT NOT NULL, hash TEXT, download TEXT NOT NULL,
      order_key TEXT, order_id TEXT, order_name TEXT, archived TEXT
    ); CREATE INDEX IF NOT EXISTS files_owner ON files(owner);
    CREATE TABLE IF NOT EXISTS limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);`);
    fs.chmodSync(path.join(this.root, 'metadata.sqlite'), 0o600);
  }
  owner(token) { if (!TOKEN.test(token || '')) fail('invalid_token', 401); return sha(token); }
  list(token) {
    const owner = this.owner(token);
    return this.db.prepare("SELECT id,name,size,created,state FROM files WHERE owner=? AND state IN ('ready','bound') ORDER BY created,id").all(owner)
      .map(row => ({ ...row, expiresAt: row.state === 'ready' ? row.created + 7 * DAY : null }));
  }
  reserve(token, id, name, size, ip) {
    const owner = this.owner(token); filename(name);
    if (!ID.test(id) || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE) fail('file_too_large', 413);
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM files WHERE id=?').get(id);
      if (existing) {
        if (existing.owner !== owner || existing.name !== name || existing.size !== size) fail('file_conflict', 409);
        if (existing.state === 'ready') return { replayed: true, id, name, size, expiresAt: existing.created + 7 * DAY };
        fail('file_in_progress', 409);
      }
      const count = this.db.prepare("SELECT count(*) n FROM files WHERE owner=? AND state != 'archived'").get(owner).n;
      if (count >= MAX_FILES) fail('too_many_files');
      const totals = this.db.prepare("SELECT COALESCE(sum(size),0) bytes,count(*) n FROM files WHERE state != 'archived'").get();
      if (this.db.prepare("SELECT count(*) n FROM files WHERE state='receiving'").get().n >= 4) fail('upload_busy', 429);
      if (totals.bytes + size > this.maxBytes || totals.n >= 10000 || this.free() < this.minFree + size + MAX_FILE * 4) fail('storage_full', 503);
      const now = this.now(), day = Math.floor(now / DAY);
      for (const [bucket, max] of [['ip:' + sha(ip) + ':' + day, 60], ['all:' + day, 500]]) {
        const row = this.db.prepare('SELECT count FROM limits WHERE bucket=?').get(bucket);
        if ((row?.count || 0) >= max) fail('upload_rate_limit', 429);
        this.db.prepare('INSERT INTO limits VALUES (?,?,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1').run(bucket, 1, (day + 2) * DAY);
      }
      this.db.prepare('INSERT INTO files(id,owner,name,size,created,state,download) VALUES (?,?,?,?,?,?,?)')
        .run(id, owner, name, size, now, 'receiving', crypto.randomBytes(32).toString('hex'));
      return { replayed: false, id, name, size, expiresAt: now + 7 * DAY };
    }).immediate();
  }
  async receive(reservation, stream) {
    const { id, size, name } = reservation;
    if (reservation.replayed) return reservation;
    const parts = []; let received = 0;
    try {
      for await (const chunk of stream) {
        received += chunk.length;
        if (received > size || received > MAX_FILE) fail('file_too_large', 413);
        parts.push(chunk);
      }
      if (received !== size) fail('incomplete_upload');
      const buffer = Buffer.concat(parts);
      await validateFile(buffer, name);
      const target = path.join(this.blobs, id);
      const fd = fs.openSync(target, 'wx', 0o600);
      try { fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.db.prepare("UPDATE files SET state='ready',hash=? WHERE id=? AND state='receiving'").run(sha(buffer), id);
      return reservation;
    } catch (error) {
      fs.rmSync(path.join(this.blobs, id), { force: true });
      this.db.prepare("DELETE FROM files WHERE id=? AND state='receiving'").run(id);
      throw error;
    }
  }
  remove(token, id) {
    const owner = this.owner(token); if (!ID.test(id)) fail('invalid_file');
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM files WHERE id=? AND owner=?').get(id, owner);
      if (!row) return;
      if (row.state !== 'ready') fail('file_locked', 409);
      fs.rmSync(path.join(this.blobs, id), { force: true });
      this.db.prepare('DELETE FROM files WHERE id=?').run(id);
    }).immediate();
  }
  bind(token, ids, key, baseUrl) {
    const owner = this.owner(token);
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length || !ids.every(id => ID.test(id)) || !/^[A-Za-z0-9_-]{16,128}$/.test(key)) fail('invalid_engraving_files');
    if (!/^https:\/\/[a-z0-9.-]+$/.test(baseUrl)) fail('uploads_unavailable', 503);
    return this.db.transaction(() => {
      const rows = ids.map(id => this.db.prepare('SELECT * FROM files WHERE id=? AND owner=?').get(id, owner));
      for (const row of rows) {
        if (!row || !['ready','bound'].includes(row.state) || (row.order_key && row.order_key !== key) || (row.state === 'ready' && row.created + 7 * DAY <= this.now())) fail('engraving_files_expired', 409);
        // Check the exact immutable bytes before creating the CRM order.
        const buffer = fs.readFileSync(path.join(this.blobs, row.id));
        if (buffer.length !== row.size || sha(buffer) !== row.hash) fail('engraving_files_unavailable', 503);
      }
      for (const row of rows) this.db.prepare("UPDATE files SET state='bound',order_key=? WHERE id=?").run(key, row.id);
      return rows.map((row, i) => `Макет ${i + 1}: ${baseUrl}/api/engraving-files/view#${row.id}.${row.download}`);
    }).immediate();
  }
  unbind(key) { this.db.prepare("UPDATE files SET state='ready',order_key=NULL WHERE order_key=? AND order_id IS NULL").run(key); }
  complete(key, orderId, orderName) { this.db.prepare("UPDATE files SET order_id=?,order_name=? WHERE order_key=? AND state='bound'").run(orderId, orderName, key); }
  download(id, secret) {
    if (!ID.test(id || '') || !TOKEN.test(secret || '')) fail('file_not_found', 404);
    const row = this.db.prepare("SELECT * FROM files WHERE id=? AND state IN ('bound','archived')").get(id);
    if (!row || !crypto.timingSafeEqual(Buffer.from(row.download), Buffer.from(secret))) fail('file_not_found', 404);
    if (row.state === 'archived') fail('file_archived', 410);
    return { name: row.name, size: row.size, path: path.join(this.blobs, id) };
  }
  cleanup() {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM files WHERE (state='ready' AND created<?) OR (state='receiving' AND created<?)").all(this.now() - 7 * DAY, this.now() - 3600000);
      for (const row of rows) { fs.rmSync(path.join(this.blobs, row.id), { force: true }); this.db.prepare('DELETE FROM files WHERE id=?').run(row.id); }
      this.db.prepare('DELETE FROM limits WHERE expires<?').run(this.now());
      return rows.length;
    }).immediate();
  }
  stats() { return this.db.prepare('SELECT state,count(*) files,COALESCE(sum(size),0) bytes FROM files GROUP BY state').all(); }
  close() { this.db.close(); }
}

let singleton;
function getStorage() {
  if (process.env.ENGRAVING_UPLOADS_ENABLED !== 'true' || !process.env.ENGRAVING_UPLOADS_DIR) fail('uploads_unavailable', 503);
  singleton ??= new EngravingStorage(process.env.ENGRAVING_UPLOADS_DIR);
  return singleton;
}
module.exports = { EngravingStorage, getStorage, validateFile, filename, UploadError, MAX_FILE, MAX_FILES, DAY };
