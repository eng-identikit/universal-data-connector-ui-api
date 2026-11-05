const express = require('express');
const Udc = require('../../models/Udc');
const Layout = require('../../models/Layout');
const udcClient = require('../../services/udcClient');
const { buildFlow, sourceKey, subscriptionKey } = require('../../services/flow');
const { maskSecrets } = require('../../services/secrets');
const { requireRole, RANK } = require('../../middlewares/requireRole');
const { httpError } = require('../../services/errors');

/**
 * UDC instances: catalog, flow (sources → UDC → sinks), blocks and an
 * authenticated proxy to each instance's API.
 *
 * Roles: viewer reads, operator edits sources/sinks/layout, admin manages the
 * catalog and the instances' users, tenants and keys.
 */
const router = express.Router();
const handle = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isViewer = (req) => RANK[req.user.role] < RANK.operator;

// ─── Catalog ─────────────────────────────────────────────────────────────

router.get('/', handle(async (req, res) => {
  const list = await Udc.list();
  const withStatus = await Promise.all(list.map(async (u) => ({ ...u, status: await udcClient.probe(await Udc.withKey(u.id)) })));
  res.json({ udcs: withStatus });
}));

/**
 * Registers an instance. Either apiKey (a service key created on the UDC) or
 * username + password of a UDC superadmin, used once to create a service key
 * and not stored.
 */
router.post('/', requireRole('admin'), handle(async (req, res) => {
  const body = req.body || {};
  const url = Udc.normalizeUrl(body.url);
  let apiKey = body.apiKey;
  if (!apiKey && body.username && body.password) {
    apiKey = await udcClient.mintServiceKey(url, body.username, body.password, `udc-ui-api (${req.user.username})`);
  }
  if (!apiKey) throw httpError(400, 'Give apiKey (a UDC service key) or username and password of a UDC superadmin');
  const status = await udcClient.probe({ name: body.name || url, url, apiKey });
  if (!body.force && (!status.reachable || !status.keyValid)) {
    throw httpError(400, `Cannot use this UDC: ${status.error}. Send force: true to register it anyway.`, { status });
  }
  const udc = await Udc.create({ ...body, url, apiKey }, req.user.username);
  res.status(201).json({ ...udc, status });
}));

router.get('/:id', handle(async (req, res) => {
  const udc = await Udc.withKey(req.params.id);
  res.json({ ...stripKey(udc), status: await udcClient.probe(udc) });
}));

// Operators move blocks on the board; everything else is for admins
router.patch('/:id', requireRole('operator'), handle(async (req, res) => {
  const body = req.body || {};
  const onlyPosition = Object.keys(body).every(k => k === 'position');
  if (!onlyPosition && RANK[req.user.role] < RANK.admin) throw httpError(403, "Role 'admin' required");
  const { username, password, ...changes } = body;
  // New service key from a superadmin's credentials (used once, not stored)
  if (username && password) {
    const current = await Udc.get(req.params.id);
    changes.apiKey = await udcClient.mintServiceKey(changes.url ? Udc.normalizeUrl(changes.url) : current.url, username, password, `udc-ui-api (${req.user.username})`);
  }
  res.json(await Udc.update(req.params.id, changes));
}));

router.delete('/:id', requireRole('admin'), handle(async (req, res) => {
  await Udc.remove(req.params.id);
  res.status(204).end();
}));

// ─── Flow and layout ─────────────────────────────────────────────────────

router.get('/:id/flow', handle(async (req, res) => {
  res.json(await buildFlow(await Udc.withKey(req.params.id), { mask: isViewer(req) }));
}));

router.put('/:id/layout', requireRole('operator'), handle(async (req, res) => {
  await Udc.get(req.params.id);
  res.json({ layout: await Layout.save(req.params.id, req.body || {}) });
}));

// ─── Blocks: sources (connectors) ────────────────────────────────────────

/** Body: { source: <connector configuration>, position?: { x, y } } */
router.post('/:id/sources', requireRole('operator'), handle(async (req, res) => {
  const udc = await Udc.withKey(req.params.id);
  const { source, position } = req.body || {};
  if (!source?.id) throw httpError(400, 'source with an id is required');
  const created = await udcClient.request(udc, 'POST', '/system/config/sources', { body: source });
  if (position) await Layout.save(udc.id, { [sourceKey(source.id)]: position });
  res.status(201).json(created);
}));

router.put('/:id/sources/:sourceId', requireRole('operator'), handle(async (req, res) => {
  const udc = await Udc.withKey(req.params.id);
  res.json(await udcClient.request(udc, 'PUT', `/system/config/sources/${encodeURIComponent(req.params.sourceId)}`, { body: req.body?.source ?? req.body }));
}));

router.delete('/:id/sources/:sourceId', requireRole('operator'), handle(async (req, res) => {
  const udc = await Udc.withKey(req.params.id);
  await udcClient.request(udc, 'DELETE', `/system/config/sources/${encodeURIComponent(req.params.sourceId)}`);
  await Layout.save(udc.id, { [sourceKey(req.params.sourceId)]: null });
  res.status(204).end();
}));

// ─── Blocks: sinks (subscriptions with their transformer) ────────────────

/** Body: { tenant, subscription: <UDC subscription>, position?: { x, y } } */
router.post('/:id/sinks', requireRole('operator'), handle(async (req, res) => {
  const udc = await Udc.withKey(req.params.id);
  const { tenant, subscription, position } = req.body || {};
  if (!tenant || !subscription) throw httpError(400, 'tenant and subscription are required');
  const created = await udcClient.request(udc, 'POST', '/subscriptions', { tenant, body: subscription });
  if (position) await Layout.save(udc.id, { [subscriptionKey(tenant, created.id)]: position });
  res.status(201).json(created);
}));

router.patch('/:id/sinks/:tenant/:subscriptionId', requireRole('operator'), handle(async (req, res) => {
  const udc = await Udc.withKey(req.params.id);
  res.json(await udcClient.request(udc, 'PATCH', `/subscriptions/${encodeURIComponent(req.params.subscriptionId)}`, {
    tenant: req.params.tenant, body: req.body?.subscription ?? req.body
  }));
}));

router.delete('/:id/sinks/:tenant/:subscriptionId', requireRole('operator'), handle(async (req, res) => {
  const udc = await Udc.withKey(req.params.id);
  await udcClient.request(udc, 'DELETE', `/subscriptions/${encodeURIComponent(req.params.subscriptionId)}`, { tenant: req.params.tenant });
  await Layout.save(udc.id, { [subscriptionKey(req.params.tenant, req.params.subscriptionId)]: null });
  res.status(204).end();
}));

// ─── Proxy to the instance's API ─────────────────────────────────────────

// Paths that change who can access an instance: admins only (reading included)
const ADMIN_PATHS = /^(users|service-keys|sessions|auth-events|apikeys)(\/|$)|^tenants\/[^/]+\/members(\/|$)/;
// Never proxied: logins and token operations belong to the instance's own users
const BLOCKED_PATHS = /^auth(\/|$)/;

/**
 * ALL /udc/:id/proxy/<path> → <udc.url>/api/v1/<path>, with the instance's
 * service key. X-Tenant is passed through. Viewers can only read, and see
 * secrets masked; changes need an operator; access management an admin.
 */
router.all('/:id/proxy/*', handle(async (req, res) => {
  const path = req.params[0] || '';
  if (BLOCKED_PATHS.test(path)) throw httpError(403, 'Authentication endpoints of the instance are not reachable through the proxy');
  const write = !['GET', 'HEAD'].includes(req.method);
  if (ADMIN_PATHS.test(path) || (write && /^tenants(\/|$)/.test(path))) {
    if (RANK[req.user.role] < RANK.admin) throw httpError(403, "Role 'admin' required");
  } else if (write && RANK[req.user.role] < RANK.operator) {
    throw httpError(403, "Role 'operator' required");
  }

  const udc = await Udc.withKey(req.params.id);
  const result = await udcClient.call(udc, req.method, `/${path}`, {
    tenant: req.get('x-tenant'),
    query: req.query,
    body: write && req.body && Object.keys(req.body).length ? req.body : (write ? {} : undefined)
  });
  const total = result.headers.get('x-total-count');
  if (total) res.setHeader('X-Total-Count', total);
  if (result.data === null) return res.status(result.status).end();
  if (typeof result.data === 'string') return res.status(result.status).type(result.headers.get('content-type') || 'text/plain').send(result.data);
  res.status(result.status).json(isViewer(req) ? maskSecrets(result.data) : result.data);
}));

function stripKey(udc) {
  const { apiKey, ...rest } = udc; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = router;
