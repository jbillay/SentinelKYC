// S5 — pure helper coverage for services/party/resolver.js.
//
// The exported _* helpers are pure synchronous functions with no I/O.
// resolveParties (async, DB) is covered by party-resolver.int.test.mjs.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  _extractAppointmentId,
  _officerKind,
  _pscKind,
  _shareholderKind,
  _officerStatus,
  _pscStatus,
} = require('../services/party/resolver.js');

// ─── _extractAppointmentId ─────────────────────────────────────────────────

describe('_extractAppointmentId', () => {
  it('extracts the officer id from the appointments path', () => {
    const officer = { links: { officer: { appointments: '/officers/abc123XYZ/appointments' } } };
    expect(_extractAppointmentId(officer)).toBe('abc123XYZ');
  });

  it('returns null when the path is absent', () => {
    expect(_extractAppointmentId({})).toBeNull();
    expect(_extractAppointmentId({ links: {} })).toBeNull();
    expect(_extractAppointmentId(null)).toBeNull();
  });

  it('returns null for a malformed path', () => {
    expect(_extractAppointmentId({ links: { officer: { appointments: '/bad/path' } } })).toBeNull();
  });

  it('handles numeric-looking ids', () => {
    const officer = { links: { officer: { appointments: '/officers/123456/appointments' } } };
    expect(_extractAppointmentId(officer)).toBe('123456');
  });
});

// ─── _officerKind ─────────────────────────────────────────────────────────

describe('_officerKind', () => {
  it('returns "organisation" when identification is present', () => {
    expect(_officerKind({ identification: { registration_number: '01234567' } })).toBe('organisation');
  });

  it('returns "individual" when identification is absent', () => {
    expect(_officerKind({ name: 'Jane Smith' })).toBe('individual');
    expect(_officerKind({ identification: null })).toBe('individual');
    expect(_officerKind({})).toBe('individual');
  });
});

// ─── _pscKind ─────────────────────────────────────────────────────────────

describe('_pscKind', () => {
  it('returns "organisation" for corporate PSC', () => {
    expect(_pscKind({ kind: 'corporate-entity-person-with-significant-control' })).toBe('organisation');
  });

  it('returns "organisation" for legal-person PSC', () => {
    expect(_pscKind({ kind: 'legal-person-person-with-significant-control' })).toBe('organisation');
  });

  it('returns "individual" for individual PSC', () => {
    expect(_pscKind({ kind: 'individual-person-with-significant-control' })).toBe('individual');
    expect(_pscKind({})).toBe('individual');
    expect(_pscKind({ kind: '' })).toBe('individual');
  });
});

// ─── _shareholderKind ─────────────────────────────────────────────────────

describe('_shareholderKind', () => {
  it('returns "organisation" when type is "corporate"', () => {
    expect(_shareholderKind({ type: 'corporate' })).toBe('organisation');
  });

  it('returns "individual" for any other type', () => {
    expect(_shareholderKind({ type: 'individual' })).toBe('individual');
    expect(_shareholderKind({})).toBe('individual');
    expect(_shareholderKind({ type: null })).toBe('individual');
  });
});

// ─── _officerStatus ───────────────────────────────────────────────────────

describe('_officerStatus', () => {
  it('returns "resigned" when resigned_on is set', () => {
    expect(_officerStatus({ resigned_on: '2020-01-01' })).toBe('resigned');
  });

  it('returns "active" when resigned_on is absent', () => {
    expect(_officerStatus({})).toBe('active');
    expect(_officerStatus({ resigned_on: null })).toBe('active');
    expect(_officerStatus({ resigned_on: '' })).toBe('active');
  });
});

// ─── _pscStatus ───────────────────────────────────────────────────────────

describe('_pscStatus', () => {
  it('returns "ceased" when ceased_on is set', () => {
    expect(_pscStatus({ ceased_on: '2021-06-01' })).toBe('ceased');
  });

  it('returns "ceased" when ceased flag is true', () => {
    expect(_pscStatus({ ceased: true })).toBe('ceased');
  });

  it('returns "active" when neither is set', () => {
    expect(_pscStatus({})).toBe('active');
    expect(_pscStatus({ ceased_on: null })).toBe('active');
    expect(_pscStatus({ ceased: false })).toBe('active');
  });
});
