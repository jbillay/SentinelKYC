// At-rest encryption for secret config fields (vendor API keys, connection
// strings). AES-256-GCM; the key comes from CONFIG_ENCRYPTION_KEY in the
// static .env (64 hex chars = 32 bytes) — generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Wire format: enc:v1:<iv-hex>:<tag-hex>:<ciphertext-hex>
// The UI never sees plaintext: API responses mask secret fields to
// { set: true } / { set: false }; sending the sentinel '__unchanged__' on
// save keeps the stored value.

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const UNCHANGED_SENTINEL = '__unchanged__';

function loadKey() {
  const hex = (process.env.CONFIG_ENCRYPTION_KEY || '').trim();
  if (!hex) {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY is not set — required to store secret config fields. ' +
        'Generate one: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CONFIG_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encryptSecret(plaintext) {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptSecret(blob) {
  if (!isEncrypted(blob)) return blob; // legacy/plaintext passthrough
  const key = loadKey();
  const [ivHex, tagHex, dataHex] = blob.slice(PREFIX.length).split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

module.exports = {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  UNCHANGED_SENTINEL,
};
