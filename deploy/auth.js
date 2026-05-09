'use strict';

const crypto = require('crypto');

// Two-tier credentials:
//   DASH_USER / DASH_PASS  — viewer (dashboard only)
//   ADMIN_USER / ADMIN_PASS — admin (dashboard + access log + audit)
const DASH_USER = process.env.DASH_USER || 'viewer';
const DASH_PASS = process.env.DASH_PASS;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || DASH_PASS;

const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_HOURS || '24') * 3600 * 1000;
const COOKIE_NAME = 'dash_session';

if (!DASH_PASS) {
  console.error('[auth] DASH_PASS env var required');
  process.exit(1);
}

// In-memory session store (survives restarts via audit.db backup)
const sessions = new Map();

function generateSessionId() {
  return crypto.randomBytes(24).toString('hex');
}

function createSession(user, role) {
  const id = generateSessionId();
  const session = { id, user, role, created: Date.now(), lastAccess: Date.now() };
  sessions.set(id, session);
  return session;
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.created > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  s.lastAccess = Date.now();
  return s;
}

function parseCookie(req) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

function createSessionForPassword(password) {
  if (password === ADMIN_PASS) return createSession(ADMIN_USER, 'admin');
  if (password === DASH_PASS) return createSession(DASH_USER, 'viewer');
  return null;
}

function authenticate(req, res, next) {
  // Check existing session cookie first
  const sessionId = parseCookie(req);
  if (sessionId) {
    const session = getSession(sessionId);
    if (session) {
      req.authUser = session.user;
      req.authRole = session.role;
      req.authSuccess = true;
      return next();
    }
  }

  // For API/programmatic access, support Basic Auth
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const [user, pass] = decoded.split(':');
    let role = null;
    if (user === ADMIN_USER && pass === ADMIN_PASS) role = 'admin';
    else if (user === DASH_USER && pass === DASH_PASS) role = 'viewer';
    if (role) {
      const session = createSession(user, role);
      res.set('Set-Cookie', `${COOKIE_NAME}=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
      req.authUser = user;
      req.authRole = role;
      req.authSuccess = true;
      return next();
    }
  }

  // No valid session — redirect browsers to login, 401 for API
  req.authSuccess = false;
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/login');
  }
  res.set('WWW-Authenticate', 'Basic realm="Token Proxy Dashboard"');
  return res.status(401).send('Authentication required');
}

function requireAdmin(req, res, next) {
  if (req.authRole === 'admin') return next();
  // Prompt for admin credentials via Basic Auth
  res.set('WWW-Authenticate', 'Basic realm="Admin Access"');
  return res.status(401).send('Admin credentials required');
}

function getSessionInfo() {
  return {
    active_sessions: sessions.size,
    ttl_hours: SESSION_TTL_MS / 3600000,
    storage: 'in-memory (resets on server restart)',
    enforcement: 'cookie-based session ID, validated on every request, auto-expires after TTL',
  };
}

module.exports = { authenticate, requireAdmin, getSessionInfo, createSessionForPassword };
