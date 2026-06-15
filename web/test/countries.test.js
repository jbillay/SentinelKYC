// Phase 2 — country/nationality helpers (pure).
import { describe, it, expect } from 'vitest'
import { nationalityIso2, countryIso2, calcAge, formatDob } from '@/lib/countries.js'

describe('nationalityIso2', () => {
  it('maps demonyms to ISO-2', () => {
    expect(nationalityIso2('British')).toBe('gb')
    expect(nationalityIso2('Irish')).toBe('ie')
    expect(nationalityIso2('  AMERICAN ')).toBe('us')
  })
  it('falls back to the country map, then a bare ISO-2, then null', () => {
    expect(nationalityIso2('France')).toBe('fr') // country name
    expect(nationalityIso2('de')).toBe('de') // looks like iso2
    expect(nationalityIso2('Klingon')).toBeNull()
    expect(nationalityIso2('')).toBeNull()
  })
})

describe('countryIso2', () => {
  it('maps country names and aliases to ISO-2', () => {
    expect(countryIso2('United Kingdom')).toBe('gb')
    expect(countryIso2('U.K.')).toBe('gb') // trailing dot stripped
    expect(countryIso2('Russian Federation')).toBe('ru')
    expect(countryIso2('Jersey')).toBe('je')
  })
  it('falls back to the demonym map then null', () => {
    expect(countryIso2('British')).toBe('gb')
    expect(countryIso2('Nowhere')).toBeNull()
  })
})

describe('calcAge', () => {
  it('computes age from a year', () => {
    const yr = new Date().getFullYear()
    expect(calcAge(yr - 40)).toBe(40)
  })
  it('subtracts a year when the birth month is later than now', () => {
    const now = new Date()
    const future = now.getMonth() + 2 // 1-based month after the current one
    if (future <= 12) {
      expect(calcAge(now.getFullYear() - 30, future)).toBe(29)
    }
  })
  it('returns null for implausible years', () => {
    expect(calcAge(1800)).toBeNull()
    expect(calcAge(null)).toBeNull()
    expect(calcAge(new Date().getFullYear() + 5)).toBeNull()
  })
})

describe('formatDob', () => {
  it('formats month + year and year-only', () => {
    expect(formatDob(1962, 4)).toBe('April 1962')
    expect(formatDob(1962)).toBe('1962')
    expect(formatDob(1962, 13)).toBe('1962') // out-of-range month ignored
  })
  it('returns null without a year', () => {
    expect(formatDob(null, 4)).toBeNull()
  })
})
