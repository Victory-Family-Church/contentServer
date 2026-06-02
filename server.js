'use strict';
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

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
  CREATE TABLE IF NOT EXISTS photos (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT    NOT NULL,
    name     TEXT    DEFAULT '',
    caption  TEXT    DEFAULT '',
    status   TEXT    NOT NULL DEFAULT 'pending',
    ip       TEXT    DEFAULT '',
    created  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );
`);

const stmts = {
  insert:        db.prepare('INSERT INTO photos (filename, name, caption, ip) VALUES (?, ?, ?, ?)'),
  pending:       db.prepare("SELECT * FROM photos WHERE status='pending' ORDER BY created DESC"),
  approved:      db.prepare("SELECT * FROM photos WHERE status='approved' ORDER BY created DESC"),
  setStatus:     db.prepare('UPDATE photos SET status=? WHERE id=?'),
  delete:        db.prepare('DELETE FROM photos WHERE id=?'),
  getById:       db.prepare('SELECT * FROM photos WHERE id=?'),
  countByIp:     db.prepare("SELECT COUNT(*) as n FROM photos WHERE ip=? AND created > strftime('%s','now') - 60"),
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
    req.on('data', chunk => { body += chunk; if (body.length > 4096) reject(new Error('too large')); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function checkModAuth(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7) === MOD_PASSWORD;
  // cookie fallback
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

  // CORS for same-LAN dev
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

  // ── Static assets (public/) ────────────────────────────────────────────────
  if (method === 'GET' && pathname.startsWith('/public/')) {
    const safe = path.normalize(pathname.replace('/public/', ''));
    return serveStatic(res, path.join(PUBLIC_DIR, safe));
  }

  // ── Uploaded images ────────────────────────────────────────────────────────
  if (method === 'GET' && pathname.startsWith('/uploads/')) {
    const safe = path.basename(pathname);
    const filePath = path.join(UPLOADS_DIR, safe);
    // Only serve images that exist in DB
    const row = db.prepare('SELECT id, status FROM photos WHERE filename=?').get(safe);
    if (!row) { res.writeHead(404); res.end(); return; }
    return serveStatic(res, filePath);
  }

  // ── POST /api/upload ───────────────────────────────────────────────────────
  if (method === 'POST' && pathname === '/api/upload') {
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
    let bytesReceived = 0;
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
        aborted = true;
        fileStream.resume();
        return;
      }
      const ext = path.extname(origName) || '.jpg';
      const safeName = crypto.randomUUID() + ext;
      filename = safeName;
      const dest = path.join(UPLOADS_DIR, safeName);
      writeStream = fs.createWriteStream(dest);

      fileStream.on('data', chunk => { bytesReceived += chunk.length; });
      fileStream.on('limit', () => {
        aborted = true;
        writeStream.destroy();
        fs.unlink(dest, () => {});
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
      // slight delay to ensure writeStream finishes
      setImmediate(() => {
        const result = stmts.insert.run(filename, name, caption, ip);
        const photo = stmts.getById.get(result.lastInsertRowid);
        broadcast({ type: 'new_upload', photo });
        json(res, 200, { ok: true });
      });
    });

    bb.on('error', err => {
      json(res, 500, { error: 'Upload error: ' + err.message });
    });

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
    if (!checkModAuth(req)) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    // GET /api/mod/queue – pending photos
    if (method === 'GET' && pathname === '/api/mod/queue') {
      return json(res, 200, stmts.pending.all());
    }

    // GET /api/mod/approved – approved photos
    if (method === 'GET' && pathname === '/api/mod/approved') {
      return json(res, 200, stmts.approved.all());
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

    // POST /api/mod/remove/:id  (remove from approved pool)
    if (method === 'POST' && pathname.startsWith('/api/mod/remove/')) {
      const id = parseInt(pathname.split('/').pop(), 10);
      const photo = stmts.getById.get(id);
      stmts.setStatus.run('rejected', id);
      if (photo) fs.unlink(path.join(UPLOADS_DIR, photo.filename), () => {});
      broadcast({ type: 'removed', id });
      return json(res, 200, { ok: true });
    }

    // GET /api/mod/qr – QR code for upload URL
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
    return json(res, 200, stmts.approved.all());
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
  // Send current approved photos on connect so display page bootstraps
  const approved = stmts.approved.all();
  ws.send(JSON.stringify({ type: 'init', photos: approved, slideInterval: SLIDE_INTERVAL }));
});

server.listen(PORT, () => {
  console.log(`Photo Wall running on http://localhost:${PORT}`);
  console.log(`  Upload:    http://localhost:${PORT}/`);
  console.log(`  Moderator: http://localhost:${PORT}/mod`);
  console.log(`  Display:   http://localhost:${PORT}/display`);
});
