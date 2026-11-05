const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const config = require('../config');
const Udc = require('../models/Udc');
const User = require('../models/User');
const { getKeycloak } = require('../middlewares/keycloak');
const { principalFromClaims } = require('../middlewares/extractToken');

/**
 * Realtime stream of an instance through this service:
 *   ws://<ui-api>/api/v1/auth/udc/<id>/stream?access_token=<UI token>&tenant=<id>
 * is authenticated with the UI's token (browsers cannot set headers on a
 * WebSocket) and piped to <udc>/api/v1/stream with the instance's service key.
 */

const PATH = /^\/api\/v1\/auth\/udc\/([^/]+)\/stream$/;

/** The UI principal of an access token, or null. */
async function principalOf(token) {
  if (!token) return null;
  const keycloak = getKeycloak();
  if (keycloak) {
    const valid = await keycloak.grantManager.validateAccessToken(token).catch(() => false);
    if (!valid) return null;
    const claims = jwt.decode(token) || {};
    const roles = claims.realm_access?.roles || [];
    if (config.keycloak.authorizedRole && !roles.includes(config.keycloak.authorizedRole)) return null;
    return principalFromClaims(claims);
  }
  try {
    const claims = jwt.verify(token, config.auth.secret, { issuer: 'udc-ui-api', algorithms: ['HS256'] });
    if (claims.typ !== 'access') return null;
    const user = await User.findActive(claims.sub);
    return user && user.token_version === claims.tv ? { id: user.id, role: user.role } : null;
  } catch {
    return null;
  }
}

function reject(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

async function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const match = PATH.exec(url.pathname);
  if (!match) return reject(socket, 404, 'Not Found');

  socket.on('error', () => socket.destroy());
  try {
    if (!await principalOf(url.searchParams.get('access_token'))) return reject(socket, 401, 'Unauthorized');
    const udc = await Udc.withKey(decodeURIComponent(match[1]));

    const target = new URL(`${udc.url}/api/v1/stream`);
    target.searchParams.set('api_key', udc.apiKey);
    const tenant = url.searchParams.get('tenant');
    if (tenant) target.searchParams.set('tenant', tenant);

    // Forward the WebSocket handshake headers; the upstream answer completes it
    const headers = {};
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    const upstream = (target.protocol === 'https:' ? https : http).request(target, {
      headers: { ...headers, Connection: 'Upgrade', Upgrade: 'websocket' },
      timeout: config.udcTimeoutMs
    });
    upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead?.length) socket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('close', () => upstreamSocket.destroy());
      upstreamSocket.on('close', () => socket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on('response', (res) => {
      res.resume();
      reject(socket, res.statusCode === 401 ? 502 : res.statusCode, 'Upstream refused');
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => reject(socket, 502, 'Bad Gateway'));
    upstream.end();
  } catch (error) {
    reject(socket, error.status === 404 ? 404 : 500, error.status === 404 ? 'Not Found' : 'Internal Server Error');
  }
}

/** Serves the stream proxy on an HTTP server. */
function attach(server) {
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });
}

module.exports = { attach };
