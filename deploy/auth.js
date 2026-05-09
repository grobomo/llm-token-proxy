'use strict';

const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASS = process.env.DASH_PASS;

if (!DASH_PASS) {
  console.error('[auth] DASH_PASS env var required');
  process.exit(1);
}

function basicAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Token Proxy Dashboard"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(auth.slice(6), 'base64').toString();
  const [user, pass] = decoded.split(':');

  if (user === DASH_USER && pass === DASH_PASS) {
    req.authUser = user;
    req.authSuccess = true;
    return next();
  }

  req.authSuccess = false;
  res.set('WWW-Authenticate', 'Basic realm="Token Proxy Dashboard"');
  return res.status(401).send('Invalid credentials');
}

module.exports = basicAuth;
