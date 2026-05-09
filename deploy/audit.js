'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const AUDIT_DB_PATH = process.env.AUDIT_DB || path.resolve(__dirname, 'audit.db');
let db;

function init() {
  db = new Database(AUDIT_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      ip TEXT NOT NULL,
      path TEXT,
      method TEXT,
      user_agent TEXT,
      auth_user TEXT,
      auth_success INTEGER DEFAULT 1,
      first_seen INTEGER DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS known_ips (
      ip TEXT PRIMARY KEY,
      first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_seen_at TEXT,
      access_count INTEGER DEFAULT 0,
      label TEXT
    )
  `);
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket.remoteAddress
    || 'unknown';
}

function logAccess(req, authSuccess) {
  const ip = getClientIp(req);
  const ua = (req.headers['user-agent'] || '').slice(0, 512);
  const role = req.authRole || 'anonymous';
  const isAdmin = role === 'admin';

  const existing = db.prepare('SELECT ip FROM known_ips WHERE ip = ?').get(ip);
  const firstSeen = !existing ? 1 : 0;

  if (firstSeen) {
    db.prepare('INSERT INTO known_ips (ip, access_count) VALUES (?, 1)').run(ip);
  } else {
    db.prepare('UPDATE known_ips SET last_seen_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\'), access_count = access_count + 1 WHERE ip = ?').run(ip);
  }

  db.prepare(`
    INSERT INTO access_log (ip, path, method, user_agent, auth_user, auth_success, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(ip, req.path, req.method, ua, req.authUser || null, authSuccess ? 1 : 0, firstSeen);

  return { ip, firstSeen, role, isAdmin };
}

function middleware(req, res, next) {
  res.on('finish', () => {
    const authSuccess = req.authSuccess !== false;
    logAccess(req, authSuccess);
  });
  next();
}

function getRecentAccess(limit = 50, filter = 'all') {
  if (filter === 'admin') {
    return db.prepare(`
      SELECT id, timestamp, ip, path, user_agent, auth_user, auth_success, first_seen
      FROM access_log WHERE auth_user = 'admin' OR path LIKE '/admin%'
      ORDER BY id DESC LIMIT ?
    `).all(limit);
  }
  if (filter === 'viewer') {
    return db.prepare(`
      SELECT id, timestamp, ip, path, user_agent, auth_user, auth_success, first_seen
      FROM access_log WHERE (auth_user != 'admin' OR auth_user IS NULL) AND path NOT LIKE '/admin%'
      ORDER BY id DESC LIMIT ?
    `).all(limit);
  }
  return db.prepare(`
    SELECT id, timestamp, ip, path, user_agent, auth_user, auth_success, first_seen
    FROM access_log ORDER BY id DESC LIMIT ?
  `).all(limit);
}

function getKnownIps() {
  return db.prepare('SELECT * FROM known_ips ORDER BY last_seen_at DESC').all();
}

module.exports = { init, middleware, getRecentAccess, getKnownIps };
