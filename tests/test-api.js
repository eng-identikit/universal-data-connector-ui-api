#!/usr/bin/env node

/**
 * universal-data-connector-ui-api integration test, against a real UDC.
 *
 *   UDC_TEST_URL             UDC base URL (default http://localhost:8080, the Compose stack)
 *   UDC_TEST_ADMIN_PASSWORD  password of the UDC superadmin 'admin' (required)
 *   UI_DB_*                  PostgreSQL for this service (default localhost, user udc);
 *                            the test uses a throw-away database and drops it.
 */

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { Client } = require('pg');

const RUN = crypto.randomBytes(3).toString('hex');
const UDC_URL = process.env.UDC_TEST_URL || 'http://localhost:8080';
const UDC_PASSWORD = process.env.UDC_TEST_ADMIN_PASSWORD;
const ADMIN_PASSWORD = 'ui-admin-pass-123';
const TENANT = `uiapi-${RUN}`;

process.env.UI_DB_NAME = `udc_ui_test_${RUN}`;
process.env.UI_ENCRYPTION_KEY = 'test-encryption-key';
process.env.UI_JWT_SECRET = 'test-jwt-secret';
process.env.UI_ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.UDC_DEFAULT_URL = '';
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
delete process.env.KEYCLOAK_URL;

if (!UDC_PASSWORD) {
  console.error('Set UDC_TEST_ADMIN_PASSWORD (the UDC superadmin password)');
  process.exit(1);
}

const { start } = require('../index');
const config = require('../config');
const { pool } = require('../db');

let base;
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n    Error: ${error.message}`);
  }
}

async function call(token, method, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, body: data };
}

const expect = (res, status) => {
  assert.strictEqual(res.status, status, `expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
};

async function main() {
  const server = await start();
  base = `http://127.0.0.1:${server.address().port}/api/v1`;
  console.log('\n=== UI API TESTS ===');

  let admin;
  let operator;
  let viewer;
  let udcId;
  let mintedKeyName;

  await test('local login, wrong password, refresh, profile', async () => {
    expect(await call(null, 'GET', '/basic/config'), 200);
    expect(await call(null, 'POST', '/basic/login', { username: 'admin', password: 'nope' }), 401);
    const s = expect(await call(null, 'POST', '/basic/login', { username: 'admin', password: ADMIN_PASSWORD }), 200);
    assert.strictEqual(s.user.role, 'admin');
    const r = expect(await call(null, 'POST', '/basic/refresh', { refreshToken: s.refreshToken }), 200);
    admin = r.accessToken;
    expect(await call(null, 'GET', '/auth/me'), 401);
    expect(await call(s.refreshToken, 'GET', '/auth/me'), 401); // a refresh token is not an access token
    assert.strictEqual(expect(await call(admin, 'GET', '/auth/me'), 200).username, 'admin');
  });

  await test('users and roles; the last admin cannot go', async () => {
    for (const [username, role] of [[`op-${RUN}`, 'operator'], [`view-${RUN}`, 'viewer']]) {
      expect(await call(admin, 'POST', '/auth/users', { username, password: 'password-123', role }), 201);
    }
    operator = expect(await call(null, 'POST', '/basic/login', { username: `op-${RUN}`, password: 'password-123' }), 200).accessToken;
    viewer = expect(await call(null, 'POST', '/basic/login', { username: `view-${RUN}`, password: 'password-123' }), 200).accessToken;
    expect(await call(viewer, 'GET', '/auth/users'), 403);
    const me = expect(await call(admin, 'GET', '/auth/me'), 200);
    expect(await call(admin, 'PATCH', `/auth/users/${me.id}`, { role: 'viewer' }), 409);
  });

  await test('register a UDC with superadmin credentials (service key minted, not stored)', async () => {
    expect(await call(operator, 'POST', '/auth/udc', { name: 'x', url: UDC_URL, username: 'admin', password: UDC_PASSWORD }), 403);
    const bad = await call(admin, 'POST', '/auth/udc', { name: 'x', url: UDC_URL, username: 'admin', password: 'wrong' });
    assert.strictEqual(bad.status, 400);
    const udc = expect(await call(admin, 'POST', '/auth/udc', { name: `Plant ${RUN}`, url: UDC_URL, username: 'admin', password: UDC_PASSWORD, position: { x: 100, y: 50 } }), 201);
    assert.strictEqual(udc.status.keyValid, true);
    udcId = udc.id;
    mintedKeyName = 'udc-ui-api (admin)';
    const { rows } = await pool.query('SELECT api_key_enc FROM udcs WHERE id = $1', [udcId]);
    assert.match(rows[0].api_key_enc, /^v1:/); // encrypted at rest
    assert.ok(!JSON.stringify(udc).includes('udc_'), 'the key must not be returned');
  });

  await test('a wrong key is refused unless forced', async () => {
    const r = await call(admin, 'POST', '/auth/udc', { name: 'bad', url: UDC_URL, apiKey: 'udc_wrongwrongwrongwrongwrong' });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error.message, /Service key rejected/);
  });

  await test('catalog with live status', async () => {
    const { udcs } = expect(await call(viewer, 'GET', '/auth/udc'), 200);
    const mine = udcs.find(u => u.id === udcId);
    assert.ok(mine.status.reachable && mine.status.ready);
  });

  await test('admin creates a tenant through the proxy; operators cannot', async () => {
    expect(await call(operator, 'POST', `/auth/udc/${udcId}/proxy/tenants`, { id: TENANT, name: 'UI API test' }), 403);
    expect(await call(admin, 'POST', `/auth/udc/${udcId}/proxy/tenants`, { id: TENANT, name: 'UI API test' }), 201);
  });

  let sinkId;
  await test('operator adds a sink block (subscription with a transformer) with its position', async () => {
    const created = expect(await call(operator, 'POST', `/auth/udc/${udcId}/sinks`, {
      tenant: TENANT,
      position: { x: 600, y: 120 },
      subscription: { name: 'to webhook', select: { types: ['Press'] }, notify: { channel: 'http', url: 'http://example.com/hook', transformer: 'flat-values', headers: { Authorization: 'Bearer secret-token' } } }
    }), 201);
    sinkId = created.id;
    expect(await call(viewer, 'POST', `/auth/udc/${udcId}/sinks`, { tenant: TENANT, subscription: {} }), 403);
  });

  await test('operator adds a source block (connector), disabled', async () => {
    expect(await call(operator, 'POST', `/auth/udc/${udcId}/sources`, {
      position: { x: -300, y: 80 },
      source: { id: `mqtt-${RUN}`, type: 'mqtt', name: 'Test MQTT', enabled: false, tenant: TENANT, config: { broker: 'mqtt://mqtt:1883', topics: ['plant/#'], password: 'mqtt-secret' } }
    }), 201);
  });

  await test('flow: sources → UDC → sinks, transformers, MCP and layout', async () => {
    const flow = expect(await call(operator, 'GET', `/auth/udc/${udcId}/flow`), 200);
    assert.strictEqual(flow.udc.status.keyValid, true);
    const source = flow.sources.find(s => s.id === `mqtt-${RUN}`);
    assert.ok(source, 'source block');
    assert.strictEqual(source.status, 'disabled');
    assert.strictEqual(source.config.password, 'mqtt-secret');
    const sink = flow.sinks.find(s => s.id === sinkId);
    assert.deepStrictEqual(sink.transformer, { kind: 'library', id: 'flat-values' });
    assert.strictEqual(sink.target, 'POST http://example.com/hook');
    assert.ok(flow.sinks.some(s => s.kind === 'mcp' && s.url.endsWith('/api/v1/mcp')));
    assert.ok(flow.transformers.some(t => t.id === 'csv'));
    assert.ok(flow.tenants.some(t => t.id === TENANT));
    assert.deepStrictEqual(flow.layout[`source:mqtt-${RUN}`], { x: -300, y: 80 });
    assert.deepStrictEqual(flow.layout[`sink:subscription:${TENANT}:${sinkId}`], { x: 600, y: 120 });
  });

  await test('viewers see secrets masked and cannot change anything', async () => {
    const flow = expect(await call(viewer, 'GET', `/auth/udc/${udcId}/flow`), 200);
    assert.strictEqual(flow.sources.find(s => s.id === `mqtt-${RUN}`).config.password, '••••');
    assert.strictEqual(flow.sinks.find(s => s.id === sinkId).subscription.notify.headers.Authorization, '••••');
    expect(await call(viewer, 'PUT', `/auth/udc/${udcId}/layout`, { 'sink:mcp': { x: 1, y: 1 } }), 403);
    expect(await call(viewer, 'PATCH', `/auth/udc/${udcId}/proxy/subscriptions/${sinkId}`, { enabled: false }, { 'X-Tenant': TENANT }), 403);
    expect(await call(viewer, 'GET', `/auth/udc/${udcId}/proxy/users`), 403);
  });

  await test('proxy: reads with X-Tenant, edits with roles, never the auth endpoints', async () => {
    const list = expect(await call(viewer, 'GET', `/auth/udc/${udcId}/proxy/subscriptions`, undefined, { 'X-Tenant': TENANT }), 200);
    assert.strictEqual(list.subscriptions.length, 1);
    expect(await call(operator, 'PATCH', `/auth/udc/${udcId}/sinks/${TENANT}/${sinkId}`, { enabled: false }), 200);
    expect(await call(admin, 'POST', `/auth/udc/${udcId}/proxy/auth/login`, { username: 'admin', password: UDC_PASSWORD }), 403);
    expect(await call(operator, 'GET', `/auth/udc/${udcId}/proxy/entities`, undefined, { 'X-Tenant': TENANT }), 200);
  });

  await test('layout: save, move, validation', async () => {
    const r = expect(await call(operator, 'PUT', `/auth/udc/${udcId}/layout`, { 'sink:mcp': { x: 700, y: 400 } }), 200);
    assert.deepStrictEqual(r.layout['sink:mcp'], { x: 700, y: 400 });
    expect(await call(operator, 'PUT', `/auth/udc/${udcId}/layout`, { 'bad key': { x: 1, y: 1 } }), 400);
    expect(await call(operator, 'PATCH', `/auth/udc/${udcId}`, { position: { x: 10, y: 20 } }), 200);
    expect(await call(operator, 'PATCH', `/auth/udc/${udcId}`, { name: 'renamed' }), 403);
  });

  await test('removing blocks removes them from the UDC and the layout', async () => {
    expect(await call(operator, 'DELETE', `/auth/udc/${udcId}/sinks/${TENANT}/${sinkId}`), 204);
    expect(await call(operator, 'DELETE', `/auth/udc/${udcId}/sources/mqtt-${RUN}`), 204);
    const flow = expect(await call(operator, 'GET', `/auth/udc/${udcId}/flow`), 200);
    assert.ok(!flow.sources.some(s => s.id === `mqtt-${RUN}`));
    assert.ok(!flow.layout[`source:mqtt-${RUN}`]);
  });

  // Cleanup: test tenant, the minted service key, the UDC record, the database
  await call(admin, 'DELETE', `/auth/udc/${udcId}/proxy/tenants/${TENANT}`);
  const keys = await call(admin, 'GET', `/auth/udc/${udcId}/proxy/service-keys`);
  for (const k of keys.body?.serviceKeys ?? []) {
    if (k.name === mintedKeyName && !k.revokedAt) await call(admin, 'DELETE', `/auth/udc/${udcId}/proxy/service-keys/${k.id}`);
  }
  await test('unregister the UDC', async () => {
    expect(await call(admin, 'DELETE', `/auth/udc/${udcId}`), 204);
    expect(await call(admin, 'GET', `/auth/udc/${udcId}`), 404);
  });

  console.log(`\nPassed: ${passed}, Failed: ${failed}`);
  server.close();
  await pool.end();
  const maintenance = new Client({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: config.db.maintenanceDb });
  await maintenance.connect();
  await maintenance.query(`DROP DATABASE IF EXISTS "${process.env.UI_DB_NAME}"`);
  await maintenance.end();
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
