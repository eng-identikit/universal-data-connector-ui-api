const { pool, withTransaction } = require('../db');
const { httpError } = require('../services/errors');

/**
 * Positions of the blocks around a UDC on the board, by node key:
 *   source:<sourceId>, sink:subscription:<tenant>:<id>, sink:mcp
 */
const NODE_KEY_RE = /^(source|sink):[A-Za-z0-9_:.@-]{1,300}$/;

const Layout = {
  async get(udcId) {
    const { rows } = await pool.query('SELECT node_key, x, y FROM udc_layout WHERE udc_id = $1', [udcId]);
    return Object.fromEntries(rows.map(r => [r.node_key, { x: r.x, y: r.y }]));
  },

  /** Upserts the given positions; null removes a node's position. */
  async save(udcId, positions) {
    if (!positions || typeof positions !== 'object') throw httpError(400, 'Body must be { "<nodeKey>": { x, y } | null }');
    const entries = Object.entries(positions);
    if (entries.length > 2000) throw httpError(400, 'Too many nodes');
    for (const [key, p] of entries) {
      if (!NODE_KEY_RE.test(key)) throw httpError(400, `Invalid node key '${key}'`);
      if (p !== null && (!Number.isFinite(p?.x) || !Number.isFinite(p?.y))) throw httpError(400, `Position of '${key}' must be { x, y } numbers`);
    }
    await withTransaction(async (client) => {
      for (const [key, p] of entries) {
        if (p === null) {
          await client.query('DELETE FROM udc_layout WHERE udc_id = $1 AND node_key = $2', [udcId, key]);
        } else {
          await client.query(
            `INSERT INTO udc_layout (udc_id, node_key, x, y) VALUES ($1, $2, $3, $4)
             ON CONFLICT (udc_id, node_key) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y`,
            [udcId, key, p.x, p.y]
          );
        }
      }
    });
    return Layout.get(udcId);
  }
};

module.exports = Layout;
