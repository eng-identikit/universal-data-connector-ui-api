const { pool } = require('../db');
const { encrypt, decrypt } = require('../services/secrets');
const { httpError } = require('../services/errors');

/** Catalog of UDC instances: where they are and the service key to reach them. */

function normalizeUrl(url, field = 'url') {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw httpError(400, `${field} must be an absolute http(s) URL, e.g. http://udc:3000`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw httpError(400, `${field} must use http or https`);
  return parsed.toString().replace(/\/+$/, '');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Throws 404 for ids that cannot exist (instead of a database type error). */
function checkId(id) {
  if (!UUID.test(String(id))) throw httpError(404, `UDC '${id}' not found`);
}

function toUdc(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    url: row.url,
    publicUrl: row.public_url,
    color: row.color,
    position: row.position,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function checkName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) throw httpError(400, 'name is required (max 100 characters)');
}

function checkPosition(position) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) throw httpError(400, 'position must be { x, y } numbers');
  return { x: position.x, y: position.y };
}

const Udc = {
  toUdc,
  normalizeUrl,

  async list() {
    const { rows } = await pool.query('SELECT * FROM udcs ORDER BY name');
    return rows.map(toUdc);
  },

  async get(id) {
    checkId(id);
    const { rows } = await pool.query('SELECT * FROM udcs WHERE id = $1', [id]);
    if (!rows.length) throw httpError(404, `UDC '${id}' not found`);
    return toUdc(rows[0]);
  },

  /** Record plus its decrypted service key, for calls to the instance. */
  async withKey(id) {
    checkId(id);
    const { rows } = await pool.query('SELECT * FROM udcs WHERE id = $1', [id]);
    if (!rows.length) throw httpError(404, `UDC '${id}' not found`);
    return { ...toUdc(rows[0]), apiKey: decrypt(rows[0].api_key_enc) };
  },

  async create({ name, description, url, publicUrl, apiKey, color, position }, createdBy) {
    checkName(name);
    if (typeof apiKey !== 'string' || !apiKey.startsWith('udc_')) throw httpError(400, 'apiKey must be a UDC service key (udc_...)');
    const { rows } = await pool.query(
      `INSERT INTO udcs (name, description, url, public_url, api_key_enc, color, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name.trim(), description || null, normalizeUrl(url), publicUrl ? normalizeUrl(publicUrl, 'publicUrl') : null,
        encrypt(apiKey), color || null, checkPosition(position || { x: 0, y: 0 }), createdBy || null]
    );
    return toUdc(rows[0]);
  },

  async update(id, { name, description, url, publicUrl, apiKey, color, position }) {
    checkId(id);
    const sets = [];
    const params = [id];
    const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    if (name !== undefined) { checkName(name); set('name', name.trim()); }
    if (description !== undefined) set('description', description || null);
    if (url !== undefined) set('url', normalizeUrl(url));
    if (publicUrl !== undefined) set('public_url', publicUrl ? normalizeUrl(publicUrl, 'publicUrl') : null);
    if (apiKey !== undefined) {
      if (typeof apiKey !== 'string' || !apiKey.startsWith('udc_')) throw httpError(400, 'apiKey must be a UDC service key (udc_...)');
      set('api_key_enc', encrypt(apiKey));
    }
    if (color !== undefined) set('color', color || null);
    if (position !== undefined) set('position', checkPosition(position));
    if (!sets.length) throw httpError(400, 'Nothing to update');
    const { rows } = await pool.query(`UPDATE udcs SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, params);
    if (!rows.length) throw httpError(404, `UDC '${id}' not found`);
    return toUdc(rows[0]);
  },

  async remove(id) {
    checkId(id);
    const { rowCount } = await pool.query('DELETE FROM udcs WHERE id = $1', [id]);
    if (!rowCount) throw httpError(404, `UDC '${id}' not found`);
  },

  async count() {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM udcs');
    return rows[0].n;
  }
};

module.exports = Udc;
