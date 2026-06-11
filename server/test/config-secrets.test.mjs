import { describe, it, expect, beforeAll } from 'vitest'
import crypto from 'node:crypto'
import { encryptSecret, decryptSecret, isEncrypted } from '../services/config/secrets.js'

beforeAll(() => {
  process.env.CONFIG_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
})

describe('config secrets (AES-256-GCM at rest)', () => {
  it('round-trips a value', () => {
    const blob = encryptSecret('sk-vendor-key-12345')
    expect(isEncrypted(blob)).toBe(true)
    expect(blob).not.toContain('sk-vendor-key')
    expect(decryptSecret(blob)).toBe('sk-vendor-key-12345')
  })

  it('produces a different ciphertext per call (fresh IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'))
  })

  it('passes plaintext through decrypt unchanged (legacy values)', () => {
    expect(decryptSecret('not-encrypted')).toBe('not-encrypted')
  })

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const blob = encryptSecret('integrity')
    const tampered = blob.slice(0, -2) + (blob.endsWith('00') ? '11' : '00')
    expect(() => decryptSecret(tampered)).toThrow()
  })

  it('refuses to encrypt without a key', () => {
    const saved = process.env.CONFIG_ENCRYPTION_KEY
    delete process.env.CONFIG_ENCRYPTION_KEY
    expect(() => encryptSecret('x')).toThrow(/CONFIG_ENCRYPTION_KEY/)
    process.env.CONFIG_ENCRYPTION_KEY = saved
  })

  it('rejects a malformed key', () => {
    const saved = process.env.CONFIG_ENCRYPTION_KEY
    process.env.CONFIG_ENCRYPTION_KEY = 'tooshort'
    expect(() => encryptSecret('x')).toThrow(/64 hex/)
    process.env.CONFIG_ENCRYPTION_KEY = saved
  })
})
