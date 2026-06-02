'use strict';
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Busboy = require('busboy');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const MOD_PASSWORD = process.env.MOD_PASSWORD || 'changeme';
const SLIDE_INTERVAL = parseInt(process.env.SLIDE_INTERVAL || '7000', 10);
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES || String(10 * 1024 * 1024), 10);
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(__dirname, 'contentserver.db');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Database ─────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    date        TEXT    DEFAULT '',
    description TEXT    DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 0,
    created     INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS photos (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER REFERENCES events(id),
    filename TEXT    NOT NULL,
    name     TEXT    DEFAULT '',
    caption  TEXT    DEFAULT '',
    status   TEXT    NOT NULL DEFAULT 'pending',
    ip       TEXT    DEFAULT '',
    created  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  // Events
  createEvent:      db.prepare('INSERT INTO events (name, date, description) VALUES (?, ?, ?)'),
  allEvents:        db.prepare('SELECT * FROM events ORDER BY created DESC'),
  getEvent:         db.prepare('SELECT * FROM events WHERE id=?'),
  activeEvent:      db.prepare('SELECT * FROM events WHERE active=1 LIMIT 1'),
  deactivateAll:    db.prepare('UPDATE events SET active=0'),
  activateEvent:    db.prepare('UPDATE events SET active=1 WHERE id=?'),
  updateEvent:      db.prepare('UPDATE events SET name=?, date=?, description=? WHERE id=?'),

  // Photos (all scoped to an event_id)
  insert:           db.prepare('INSERT INTO photos (event_id, filename, name, caption, ip) VALUES (?, ?, ?, ?, ?)'),
  pendingFor:       db.prepare("SELECT * FROM photos WHERE event_id=? AND status='pending' ORDER BY created DESC"),
  approvedFor:      db.prepare("SELECT * FROM photos WHERE event_id=? AND status='approved' ORDER BY created DESC"),
  setStatus:        db.prepare('UPDATE photos SET status=? WHERE id=?'),
  getById:          db.prepare('SELECT * FROM photos WHERE id=?'),
  countByIp:        db.prepare("SELECT COUNT(*) as n FROM photos WHERE ip=? AND created > strftime('%s','now') - 60"),
};

// ─── Rate limiting ────────────────────────────────────────────────────────────
const RATE_LIMIT = 5; // uploads per IP per minute

// ─── WebSocket broadcast ──────────────────────────────────────────────────────
let wss;
function broadcast(msg) {
  if (!wss) return;
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function getMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic' };
  return map[ext] || 'application/octet-stream';
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = getMime(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 16384) reject(new Error('too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function checkModAuth(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7) === MOD_PASSWORD;
  const cookie = req.headers['cookie'] || '';
  const match = cookie.match(/mod_token=([^;]+)/);
  return match ? match[1] === MOD_PASSWORD : false;
}

function getBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.headers['host'] || `localhost:${PORT}`;
  return `http://${host}`;
}

// ─── HTTP Handler ─────────────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static pages ──────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'upload.html'));
  }
  if (method === 'GET' && pathname === '/mod') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'mod.html'));
  }
  if (method === 'GET' && pathname === '/display') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'display.html'));
  }

  // ── Static assets ─────────────────────────────────────────────────────────
  if (method === 'GET' && pathname.startsWith('/public/')) {
    const safe = path.normalize(pathname.replace('/public/', ''));
    return serveStatic(res, path.join(PUBLIC_DIR, safe));
  }

  // ── Uploaded images ────────────────────────────────────────────────────────
  if (method === 'GET' && pathname.startsWith('/uploads/')) {
    const safe = path.basename(pathname);
    const row = db.prepare('SELECT id FROM photos WHERE filename=?').get(safe);
    if (!row) { res.writeHead(404); res.end(); return; }
    return serveStatic(res, path.join(UPLOADS_DIR, safe));
  }

  // ── Public: active event info (used by upload page) ───────────────────────
  if (method === 'GET' && pathname === '/api/event') {
    const event = stmts.activeEvent.get();
    return json(res, 200, { event: event || null });
  }

  // ── POST /api/upload ───────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/upload') {
    // Check for active event first
    const activeEvent = stmts.activeEvent.get();
    if (!activeEvent) {
      return json(res, 503, { error: 'Uploads are not open right now — no active event. Check back soon!' });
    }

    const ip = getClientIp(req);
    const count = stmts.countByIp.get(ip);
    if (count.n >= RATE_LIMIT) {
      return json(res, 429, { error: 'Too many uploads, please wait a moment.' });
    }

    const ct = req.headers['content-type'] || '';
    if (!ct.includes('multipart/form-data')) {
      return json(res, 400, { error: 'Expected multipart/form-data' });
    }

    let name = '';
    let caption = '';
    let filename = '';
    let fileWritten = false;
    let aborted = false;
    let writeStream = null;

    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

    bb.on('field', (fieldname, val) => {
      if (fieldname === 'name') name = val.slice(0, 80);
      if (fieldname === 'caption') caption = val.slice(0, 200);
    });

    bb.on('file', (fieldname, fileStream, info) => {
      const { filename: origName, mimeType } = info;
      if (!mimeType.startsWith('image/')) {
        aborted = true; fileStream.resume(); return;
      }
      const ext = path.extname(origName) || '.jpg';
      const safeName = crypto.randomUUID() + ext;
      filename = safeName;
      const dest = path.join(UPLOADS_DIR, safeName);
      writeStream = fs.createWriteStream(dest);
      fileStream.on('limit', () => {
        aborted = true; writeStream.destroy(); fs.unlink(dest, () => {});
      });
      fileStream.pipe(writeStream);
      writeStream.on('finish', () => { if (!aborted) fileWritten = true; });
    });

    bb.on('finish', () => {
      if (aborted) {
        return json(res, 400, { error: 'File too large or invalid type. Max ' + Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB, images only.' });
      }
      if (!fileWritten && !filename) {
        return json(res, 400, { error: 'No image received.' });
      }
      setImmediate(() => {
        // Re-check active event (could have changed during upload)
        const ev = stmts.activeEvent.get();
        if (!ev) return json(res, 503, { error: 'Event ended while uploading. Please try again.' });
        const result = stmts.insert.run(ev.id, filename, name, caption, ip);
        const photo = stmts.getById.get(result.lastInsertRowid);
        broadcast({ type: 'new_upload', photo });
        json(res, 200, { ok: true });
      });
    });

    bb.on('error', err => json(res, 500, { error: 'Upload error: ' + err.message }));
    req.pipe(bb);
    return;
  }

  // ── Mod auth ───────────────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/mod/login') {
    const body = await readBody(req).catch(() => '{}');
    const { password } = JSON.parse(body);
    if (password === MOD_PASSWORD) {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `mod_token=${MOD_PASSWORD}; Path=/; HttpOnly; SameSite=Lax`
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      json(res, 401, { error: 'Wrong password' });
    }
    return;
  }

  // ── Mod API (auth required) ────────────────────────────────────────────────
  if (pathname.startsWith('/api/mod/')) {
    if (!checkModAuth(req)) return json(res, 401, { error: 'Unauthorized' });

    // GET /api/mod/events
    if (method === 'GET' && pathname === '/api/mod/events') {
      return json(res, 200, stmts.allEvents.all());
    }

    // POST /api/mod/events  – create new event
    if (method === 'POST' && pathname === '/api/mod/events') {
      const body = await readBody(req).catch(() => '{}');
      const { name, date = '', description = '' } = JSON.parse(body);
      if (!name || !name.trim()) return json(res, 400, { error: 'Event name is required.' });
      const result = stmts.createEvent.run(name.trim().slice(0, 100), date.slice(0, 20), description.slice(0, 500));
      const event = stmts.getEvent.get(result.lastInsertRowid);
      return json(res, 200, { ok: true, event });
    }

    // POST /api/mod/events/:id/activate
    if (method === 'POST' && pathname.match(/^\/api\/mod\/events\/\d+\/activate$/)) {
      const id = parseInt(pathname.split('/')[4], 10);
      const event = stmts.getEvent.get(id);
      if (!event) return json(res, 404, { error: 'Event not found' });
      db.transaction(() => {
        stmts.deactivateAll.run();
        stmts.activateEvent.run(id);
      })();
      const updated = stmts.getEvent.get(id);
      const approved = stmts.approvedFor.all(id);
      broadcast({ type: 'event_changed', event: updated, photos: approved, slideInterval: SLIDE_INTERVAL });
      return json(res, 200, { ok: true, event: updated });
    }

    // POST /api/mod/events/:id/deactivate  – clear active event
    if (method === 'POST' && pathname.match(/^\/api\/mod\/events\/\d+\/deactivate$/)) {
      stmts.deactivateAll.run();
      broadcast({ type: 'event_changed', event: null, photos: [], slideInterval: SLIDE_INTERVAL });
      return json(res, 200, { ok: true });
    }

    // PATCH /api/mod/events/:id
    if (method === 'PATCH' && pathname.match(/^\/api\/mod\/events\/\d+$/)) {
      const id = parseInt(pathname.split('/').pop(), 10);
      const body = await readBody(req).catch(() => '{}');
      const { name, date = '', description = '' } = JSON.parse(body);
      if (!name || !name.trim()) return json(res, 400, { error: 'Event name is required.' });
      stmts.updateEvent.run(name.trim().slice(0, 100), date.slice(0, 20), description.slice(0, 500), id);
      const event = stmts.getEvent.get(id);
      if (event.active) broadcast({ type: 'event_updated', event });
      return json(res, 200, { ok: true, event });
    }

    // ── Photo moderation (all scoped to active event) ──────────────────────
    const activeEvent = stmts.activeEvent.get();

    // GET /api/mod/queue
    if (method === 'GET' && pathname === '/api/mod/queue') {
      if (!activeEvent) return json(res, 200, []);
      return json(res, 200, stmts.pendingFor.all(activeEvent.id));
    }

    // GET /api/mod/approved
    if (method === 'GET' && pathname === '/api/mod/approved') {
      if (!activeEvent) return json(res, 200, []);
      return json(res, 200, stmts.approvedFor.all(activeEvent.id));
    }

    // POST /api/mod/approve/:id
    if (method === 'POST' && pathname.startsWith('/api/mod/approve/')) {
      const id = parseInt(pathname.split('/').pop(), 10);
      stmts.setStatus.run('approved', id);
      const photo = stmts.getById.get(id);
      broadcast({ type: 'approved', photo });
      return json(res, 200, { ok: true });
    }

    // POST /api/mod/reject/:id
    if (method === 'POST' && pathname.startsWith('/api/mod/reject/')) {
      const id = parseInt(pathname.split('/').pop(), 10);
      const photo = stmts.getById.get(id);
      stmts.setStatus.run('rejected', id);
      if (photo) fs.unlink(path.join(UPLOADS_DIR, photo.filename), () => {});
      broadcast({ type: 'rejected', id });
      return json(res, 200, { ok: true });
    }

    // POST /api/mod/remove/:id
    if (method === 'POST' && pathname.startsWith('/api/mod/remove/')) {
      const id = parseInt(pathname.split('/').pop(), 10);
      const photo = stmts.getById.get(id);
      stmts.setStatus.run('rejected', id);
      if (photo) fs.unlink(path.join(UPLOADS_DIR, photo.filename), () => {});
      broadcast({ type: 'removed', id });
      return json(res, 200, { ok: true });
    }

    // GET /api/mod/qr
    if (method === 'GET' && pathname === '/api/mod/qr') {
      const uploadUrl = getBaseUrl(req) + '/';
      try {
        const dataUrl = await QRCode.toDataURL(uploadUrl, { width: 300, margin: 2 });
        json(res, 200, { qr: dataUrl, url: uploadUrl });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }

    // GET /api/mod/config
    if (method === 'GET' && pathname === '/api/mod/config') {
      return json(res, 200, { slideInterval: SLIDE_INTERVAL });
    }
  }

  // ── Public display API ─────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/display/photos') {
    const event = stmts.activeEvent.get();
    if (!event) return json(res, 200, []);
    return json(res, 200, stmts.approvedFor.all(event.id));
  }

  if (method === 'GET' && pathname === '/api/display/config') {
    return json(res, 200, { slideInterval: SLIDE_INTERVAL });
  }

  res.writeHead(404); res.end('Not found');
}

// ─── Server bootstrap ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) { res.writeHead(500); res.end('Internal error'); }
  });
});

wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  const event = stmts.activeEvent.get();
  const photos = event ? stmts.approvedFor.all(event.id) : [];
  ws.send(JSON.stringify({ type: 'init', event: event || null, photos, slideInterval: SLIDE_INTERVAL }));
});

server.listen(PORT, () => {
  console.log(`contentServer running on http://localhost:${PORT}`);
  console.log(`  Upload:    http://localhost:${PORT}/`);
  console.log(`  Moderator: http://localhost:${PORT}/mod`);
  console.log(`  Display:   http://localhost:${PORT}/display`);
});
