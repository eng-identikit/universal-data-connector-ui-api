const udcClient = require('./udcClient');
const Layout = require('../models/Layout');
const { maskSecrets } = require('./secrets');

/**
 * The flow of one UDC as the board draws it:
 *   sources (connectors, the data coming in) → UDC → sinks (subscriptions over
 *   HTTP/MQTT/NATS/WebSocket with their transformer, and the MCP endpoint)
 * plus the transformer library, the tenants and the saved block positions.
 *
 * Sections are read in parallel; one that fails is reported in `errors` and
 * the rest of the flow is still returned.
 */

const sourceKey = (id) => `source:${id}`;
const subscriptionKey = (tenant, id) => `sink:subscription:${tenant}:${id}`;
const MCP_KEY = 'sink:mcp';

function target(notify) {
  switch (notify.channel) {
    case 'http': return `${notify.method || 'POST'} ${notify.url}`;
    case 'mqtt': return `${notify.topic}${notify.url ? ` @ ${notify.url}` : ''}`;
    case 'nats': return `${notify.subject}${notify.url ? ` @ ${notify.url}` : ''}`;
    default: return 'websocket stream';
  }
}

function transformerOf(notify) {
  if (notify.transform?.expression) return { kind: 'inline', expression: notify.transform.expression };
  if (notify.transformer) return { kind: 'library', id: notify.transformer };
  return null;
}

/** Status of a sink from its statistics: ok, failing, paused, idle. */
function subscriptionStatus(sub) {
  if (!sub.enabled) return 'paused';
  const s = sub.stats || {};
  if (s.lastFailureAt && (!s.lastSuccessAt || s.lastFailureAt > s.lastSuccessAt)) return 'failing';
  return s.delivered ? 'ok' : 'idle';
}

async function section(errors, name, fn) {
  try {
    return await fn();
  } catch (error) {
    errors.push({ section: name, message: error.message });
    return null;
  }
}

async function buildFlow(udc, { mask = false } = {}) {
  const errors = [];
  const status = await udcClient.probe(udc);
  const layout = await Layout.get(udc.id);
  const base = { udc: { ...stripKey(udc), status }, sources: [], sinks: [], transformers: [], tenants: [], layout, errors };
  if (!status.reachable || !status.keyValid) {
    errors.push({ section: 'udc', message: status.error || 'UDC not ready' });
    return base;
  }

  const [sources, tenants, transformers, mcp] = await Promise.all([
    section(errors, 'sources', () => udcClient.request(udc, 'GET', '/system/sources')),
    section(errors, 'tenants', () => udcClient.request(udc, 'GET', '/tenants')),
    section(errors, 'transformers', () => udcClient.request(udc, 'GET', '/transformers')),
    section(errors, 'mcp', () => udcClient.request(udc, 'GET', '/mcp-info'))
  ]);

  const tenantList = tenants?.tenants ?? [];
  const perTenant = await Promise.all(tenantList.map(t =>
    section(errors, `subscriptions:${t.id}`, () => udcClient.request(udc, 'GET', '/subscriptions', { tenant: t.id }))
      .then(r => (r?.subscriptions ?? []).map(sub => ({ ...sub, tenant: t.id })))
  ));

  base.tenants = tenantList.map(t => ({ id: t.id, name: t.name }));
  base.transformers = (transformers?.transformers ?? []).map(t => ({ id: t.id, name: t.name, description: t.description }));
  base.sources = (sources?.sources ?? []).map(s => ({
    key: sourceKey(s.id),
    id: s.id,
    name: s.name || s.id,
    type: s.type,
    enabled: s.enabled !== false,
    tenant: s.tenant || 'default',
    tags: s.tags || [],
    entityIdPrefix: s.entityIdPrefix || null,
    status: s.enabled === false ? 'disabled' : (s.runtime?.status || 'unknown'),
    stats: s.runtime?.stats || null,
    lastActivity: s.runtime?.lastActivity || null,
    // Cluster: the replica running the connector
    instance: s.runtime?.instance || null,
    config: mask ? maskSecrets(s.config || {}) : (s.config || {})
  }));
  base.sinks = perTenant.flat().map(sub => ({
    key: subscriptionKey(sub.tenant, sub.id),
    kind: 'subscription',
    id: sub.id,
    tenant: sub.tenant,
    name: sub.name,
    enabled: sub.enabled,
    channel: sub.notify.channel,
    target: target(sub.notify),
    transformer: transformerOf(sub.notify),
    status: subscriptionStatus(sub),
    stats: sub.stats || null,
    subscription: mask ? maskSecrets(sub) : sub
  }));
  if (mcp) {
    const origin = udc.publicUrl || udc.url;
    base.sinks.push({
      key: MCP_KEY,
      kind: 'mcp',
      enabled: mcp.enabled,
      status: mcp.enabled ? 'ok' : 'disabled',
      url: `${origin}${mcp.path}`,
      transport: mcp.transport,
      tools: mcp.tools
    });
  }
  return base;
}

function stripKey(udc) {
  const { apiKey, ...rest } = udc; // eslint-disable-line no-unused-vars
  return rest;
}

module.exports = { buildFlow, sourceKey, subscriptionKey, MCP_KEY };
