const config = require('../config');
const { httpError } = require('./errors');

/**
 * Calls to a UDC instance with its service key. Paths are relative to the
 * instance's /api/v1, e.g. call(udc, 'GET', '/system/sources').
 */
async function call(udc, method, path, { body, tenant, query, timeoutMs = config.udcTimeoutMs } = {}) {
  const url = new URL(`${udc.url}/api/v1${path.startsWith('/') ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    for (const item of [].concat(v)) url.searchParams.append(k, String(item));
  }
  const headers = { Authorization: `Bearer ${udc.apiKey}`, Accept: 'application/json' };
  if (tenant) headers['X-Tenant'] = tenant;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : (error.cause?.code || error.message);
    throw httpError(502, `UDC '${udc.name}' is not reachable at ${udc.url}: ${reason}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** Like call(), but throws on an error status with the instance's message. */
async function request(udc, method, path, options) {
  const res = await call(udc, method, path, options);
  if (res.status >= 400) {
    const message = res.data?.message || res.data?.error?.message || (typeof res.data?.error === 'string' ? res.data.error : null) || `HTTP ${res.status}`;
    const status = res.status === 401 ? 502 : res.status;
    throw httpError(status, res.status === 401
      ? `UDC '${udc.name}' rejected the service key: update it in the UDC settings`
      : `UDC '${udc.name}': ${message}`, res.data?.details);
  }
  return res.data;
}

/** Health without credentials, plus a check that the service key works. */
async function probe(udc) {
  const started = Date.now();
  try {
    const health = await call(udc, 'GET', '/health', { timeoutMs: 4000 });
    const me = await call(udc, 'GET', '/auth/me', { timeoutMs: 4000 });
    return {
      reachable: true,
      ready: !!health.data?.ready,
      keyValid: me.status === 200 && me.data?.kind === 'service',
      latencyMs: Date.now() - started,
      cluster: !!health.data?.cluster,
      messaging: health.data?.messaging ?? null,
      sessions: health.data?.sessions ?? null,
      defaultBrokers: health.data?.defaultBrokers ?? null,
      error: me.status === 200 ? (me.data?.kind === 'service' ? null : 'The key is not a service key') : `Service key rejected (HTTP ${me.status})`
    };
  } catch (error) {
    return { reachable: false, ready: false, keyValid: false, latencyMs: null, error: error.message };
  }
}

/**
 * Creates a service key on an instance with a superadmin's credentials (used
 * once when registering a UDC; the credentials are not stored).
 */
async function mintServiceKey(url, username, password, name) {
  const base = `${url}/api/v1`;
  const post = async (path, body, token) => {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.udcTimeoutMs)
      });
    } catch (error) {
      throw httpError(502, `UDC not reachable at ${url}: ${error.cause?.code || error.message}`);
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw httpError(res.status === 401 ? 400 : 502, `UDC ${path}: ${data?.message || `HTTP ${res.status}`}`);
    return data;
  };
  const session = await post('/auth/login', { username, password });
  if (!session.user?.isSuperadmin) throw httpError(400, `User '${username}' is not a superadmin on that UDC`);
  const created = await post('/service-keys', { name }, session.accessToken);
  // The login session is not needed any more
  await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  return created.key;
}

module.exports = { call, request, probe, mintServiceKey };
