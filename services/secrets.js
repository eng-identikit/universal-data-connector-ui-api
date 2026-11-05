const crypto = require('crypto');
const config = require('../config');

/**
 * Encryption of the UDC service keys kept in the catalog (AES-256-GCM, key
 * derived from UI_ENCRYPTION_KEY), and masking of secrets in UDC answers shown
 * to users who are not admins.
 */

let key = null;
function encryptionKey() {
  if (!key) {
    if (!config.encryptionKey) {
      throw new Error('UI_ENCRYPTION_KEY is not set: it is needed to store UDC service keys');
    }
    key = crypto.createHash('sha256').update(config.encryptionKey).digest();
  }
  return key;
}

/** "v1:<iv>:<tag>:<data>", all base64url. */
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data].map(p => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
}

function decrypt(stored) {
  const [version, iv, tag, data] = String(stored).split(':');
  if (version !== 'v1') throw new Error('Unknown encrypted value format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

const MASK = '••••';
const SECRET_KEY_RE = /pass(word)?|secret|token|api[-_]?key|apikey|credential|private[-_]?key|authorization/i;
const URL_CREDENTIALS_RE = /\/\/([^/\s:@]+):([^@\s/]+)@/g;

/** Copy of a JSON value with secret-looking fields and URL credentials masked. */
function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [
      k,
      SECRET_KEY_RE.test(k) && v !== null && typeof v !== 'object' && v !== '' ? MASK : maskSecrets(v)
    ]));
  }
  if (typeof value === 'string') return value.replace(URL_CREDENTIALS_RE, `//$1:${MASK}@`);
  return value;
}

module.exports = { encrypt, decrypt, maskSecrets, MASK };
