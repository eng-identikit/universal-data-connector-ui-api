const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const config = require('./config');
const { ensureDatabase, migrate } = require('./db');
const seed = require('./seed');
const { getKeycloak } = require('./middlewares/keycloak');

/**
 * universal-data-connector-ui-api: backend for frontend of the UDC UI.
 * Keeps the catalog of UDC instances and the board layout in PostgreSQL,
 * authenticates the UI's users (local or Keycloak) and talks to each UDC with
 * its service key.
 */
const app = express();
app.disable('etag');
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: config.express_limit }));
if (config.stage !== 'test') app.use(morgan(config.stage === 'production' ? 'combined' : 'dev'));
app.use(cors());
const keycloak = getKeycloak();
if (keycloak) app.use(keycloak.middleware());

app.use('/api', require('./routes'));

app.use((req, res, next) => {
  const error = new Error(`No route for ${req.method} ${req.originalUrl}`);
  error.status = 404;
  next(error);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: {
      message: status >= 500 && config.stage === 'production' ? 'Internal server error' : err.message,
      ...(err.details !== undefined && { details: err.details })
    }
  });
});

async function start() {
  await ensureDatabase();
  await migrate();
  await seed.createAdmin();
  await seed.registerDefaultUdc();
  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      console.log(`UDC UI API listening on port ${config.port} (${keycloak ? 'Keycloak' : 'local'} login)`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error(`Startup failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { app, start };
