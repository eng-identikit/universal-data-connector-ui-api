const crypto = require('crypto');

/** Configuration from the environment (see .env.example). */
const config = {
  stage: process.env.NODE_ENV || 'development',
  port: process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 9000,
  express_limit: process.env.EXPRESS_LIMIT || '5mb',

  db: {
    url: process.env.UI_DB_URL || null,
    host: process.env.UI_DB_HOST || 'localhost',
    port: Number(process.env.UI_DB_PORT) || 5432,
    name: process.env.UI_DB_NAME || 'udc_ui',
    user: process.env.UI_DB_USER || 'udc',
    password: process.env.UI_DB_PASSWORD || '',
    // Created at startup when missing, through this maintenance database
    maintenanceDb: process.env.UI_DB_MAINTENANCE || 'postgres'
  },

  auth: {
    // Signs the UI's tokens (local login)
    secret: process.env.UI_JWT_SECRET || null,
    accessTtl: process.env.UI_ACCESS_TOKEN_TTL || '1h',
    refreshTtl: process.env.UI_REFRESH_TOKEN_TTL || '7d'
  },

  // Encrypts the UDC service keys stored in the catalog (AES-256-GCM)
  encryptionKey: process.env.UI_ENCRYPTION_KEY || null,

  // Admin created on the first start (local login only)
  admin: {
    username: process.env.UI_ADMIN_USER || 'admin',
    password: process.env.UI_ADMIN_PASSWORD || null
  },

  keycloak: {
    url: process.env.KEYCLOAK_URL || null,
    realm: process.env.KEYCLOAK_REALM || null,
    clientId: process.env.KEYCLOAK_CLIENT || null,
    // Public client the SPA logs in with (defaults to KEYCLOAK_CLIENT)
    uiClientId: process.env.KEYCLOAK_UI_CLIENT || process.env.KEYCLOAK_CLIENT || null,
    authorizedRole: process.env.KEYCLOAK_AUTHORIZED_ROLE || null,
    // Realm roles mapped to the UI roles; anything else is a viewer
    adminRole: process.env.KEYCLOAK_ADMIN_ROLE || 'udc-admin',
    operatorRole: process.env.KEYCLOAK_OPERATOR_ROLE || 'udc-operator'
  },

  // UDC registered on the first start (e.g. the one in the same Compose stack)
  defaultUdc: {
    name: process.env.UDC_DEFAULT_NAME || 'UDC',
    url: process.env.UDC_DEFAULT_URL || null,
    publicUrl: process.env.UDC_DEFAULT_PUBLIC_URL || null,
    apiKey: process.env.UDC_DEFAULT_KEY || null
  },

  udcTimeoutMs: Number(process.env.UDC_TIMEOUT_MS) || 10000
};

if (!config.auth.secret) {
  config.auth.secret = crypto.randomBytes(48).toString('base64');
  console.warn('UI_JWT_SECRET not set: using a random secret, sessions end at every restart');
}

module.exports = config;
