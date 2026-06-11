// P1 R5 — corroboration gate for EXACT-name auto-links (individuals only).
//
// An EXACT canonical-name match (sim 1.0) is NOT sufficient evidence that two
// records are the same human — two real people can share a name. Before the
// resolver auto-links, it requires at least one corroborating identifier to
// be present AND consistent on both sides:
//
//   * date of birth — year must match; month must also match when both sides
//     carry it (CH only publishes year+month for officers/PSCs).
//   * nationality — the two arrays must intersect (case-insensitive).
//
// Outcomes:
//   { ok: true,  signalsUsed: ['dob_year','dob_month','nationality'] }  → auto-link
//   { ok: false, reason: 'dob_mismatch' | 'nationality_disjoint' }      → review
//   { ok: false, reason: 'no_corroborating_signal' }                    → review
//     (bare-name match — neither side has any identifier; this is the
//      doc-extracted-shareholder case and the deliberate safe default)
//
// Pure and synchronous — table-testable, no I/O. Corporates never reach this
// gate (their strong key is the registration number, checked first).

function normList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((s) => String(s || '').trim().toLowerCase())
    .filter(Boolean);
}

function corroborate(incoming, candidate) {
  const signalsUsed = [];

  const inYear = incoming?.dateOfBirthYear ?? null;
  const candYear = candidate?.dateOfBirthYear ?? null;
  const inMonth = incoming?.dateOfBirthMonth ?? null;
  const candMonth = candidate?.dateOfBirthMonth ?? null;

  if (inYear != null && candYear != null) {
    if (Number(inYear) !== Number(candYear)) {
      return { ok: false, reason: 'dob_mismatch', signalsUsed: [] };
    }
    signalsUsed.push('dob_year');
    if (inMonth != null && candMonth != null) {
      if (Number(inMonth) !== Number(candMonth)) {
        return { ok: false, reason: 'dob_mismatch', signalsUsed: [] };
      }
      signalsUsed.push('dob_month');
    }
  }

  const inNat = normList(incoming?.nationality);
  const candNat = normList(candidate?.nationality);
  if (inNat.length && candNat.length) {
    const candSet = new Set(candNat);
    if (!inNat.some((n) => candSet.has(n))) {
      return { ok: false, reason: 'nationality_disjoint', signalsUsed: [] };
    }
    signalsUsed.push('nationality');
  }

  if (signalsUsed.length === 0) {
    return { ok: false, reason: 'no_corroborating_signal', signalsUsed: [] };
  }
  return { ok: true, reason: null, signalsUsed };
}

module.exports = { corroborate };
