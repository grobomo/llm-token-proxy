// CloudFront Function — cookie-based password-only auth for tokentracker.click
// Password hash (SHA-256 of "proxy1") checked against cookie value.
// Login page at /login.html sets the cookie client-side after hashing.

var VALID_HASH = '0c41f5b812947c2b28981b4f4817c10bbacd5e48d3175bea962f81892197e8fd';

function handler(event) {
  var request = event.request;
  var headers = request.headers;
  var uri = request.uri;

  if (uri === '/login.html') return request;

  var cookies = request.cookies || {};
  var dashAuth = cookies.dash_auth && cookies.dash_auth.value;
  if (dashAuth === VALID_HASH) {
    if (uri === '/' || uri === '/dashboard' || uri === '/dashboard/') {
      request.uri = '/dashboard/index.html';
    }
    return request;
  }

  return {
    statusCode: 302,
    statusDescription: 'Found',
    headers: { location: { value: '/login.html' } },
  };
}
