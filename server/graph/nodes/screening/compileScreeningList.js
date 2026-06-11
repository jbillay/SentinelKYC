// Deterministic. No LLM. Subjects are the union of:
//   - the company itself (from profile)
//   - officers (from officers.items)
//   - PSCs (from psc.items)
//   - extracted shareholders not already covered by a PSC (deduped on
//     normalized name). Authorized signatories and recursive ownership-chain
//     walking are explicitly out of scope for v1.
//
// Subject id pattern (Phase 2):
//   - If state.partyLinks is populated (the resolver ran), we group links
//     by their party and emit ONE subject per party. subjectId becomes
//     `party:<uuid>` — stable across runs and dossiers.
//   - Otherwise (e.g. pre-Phase-2 thread or resolver was skipped because
//     no dossierId was in config), fall back to the legacy
//     `${source}:${normalizedName}` form so screening still works.
//
// The legacy fallback path stays as a single block at the bottom for
// reviewer clarity.

const { traceEvent } = require('../../state');
const { withFragment } = require('../../fragments');
const { normalizeName } = require('../../../services/sanctions/normalize');

function classifyPscKind(p) {
  const k = String(p?.kind || '').toLowerCase();
  if (k.includes('corporate') || k.includes('legal-person')) return 'corporate';
  return 'individual';
}

function classifyShareholderKind(sh) {
  if (sh?.type === 'corporate') return 'corporate';
  return 'individual';
}

function pickDob(p) {
  // PSCs and officers carry { date_of_birth: { year, month, day? } }.
  // Sanctions matching only needs year + month.
  const dob = p?.date_of_birth;
  if (!dob || !dob.year) return undefined;
  if (dob.month) return `${dob.year}-${String(dob.month).padStart(2, '0')}`;
  return String(dob.year);
}

function pickNationality(p) {
  if (!p?.nationality) return undefined;
  if (Array.isArray(p.nationality)) return p.nationality.filter(Boolean);
  return [String(p.nationality)];
}

function makeSubject({ source, name, kind, role, dob, nationality }) {
  const normalized = normalizeName(name);
  return {
    id: `${source}:${normalized}`,
    name,
    normalizedName: normalized,
    kind,
    source,
    dob,
    nationality,
    role,
  };
}

// Phase 2 — party-aware path. One subject per ACTIVE party_link on this run.
// The company itself isn't a party in our model; it's added separately via
// the profile source so the matcher can screen the company name against
// sanctions lists.
async function compileSubjectsFromParties(state) {
  const subjects = [];
  const seenPartyKey = new Set();

  // 1. Company itself — still emitted under source='profile'; not a party.
  const companyName = state.kycCard?.identity?.name || state.profile?.company_name;
  if (companyName) {
    subjects.push(
      makeSubject({
        source: 'profile',
        name: companyName,
        kind: 'company',
      }),
    );
  }

  // 2. One subject per (party × role). Active links only. Re-fetch the
  // parties briefly to get full identity attributes (DOB, nationality)
  // that aren't in the slim state shape.
  const partiesById = new Map(
    (state.parties || []).map((p) => [p.id, p]),
  );
  const officersByName = new Map(
    (state.officers?.items || [])
      .filter((o) => o?.name)
      .map((o) => [normalizeName(o.name), o]),
  );
  const pscByName = new Map(
    (state.psc?.items || [])
      .filter((p) => p?.name)
      .map((p) => [normalizeName(p.name), p]),
  );

  for (const link of state.partyLinks || []) {
    if (link.status !== 'active') continue;
    if (!link.partyId || !partiesById.has(link.partyId)) continue;
    // We treat one subject per role-bearing link. A person who is both
    // officer + PSC produces TWO subjects with the same partyId (different
    // roles for the per-list audit clarity). That's identical to the
    // legacy behaviour where we'd emit two synthetic subjects too.
    const key = `${link.partyId}:${link.role}`;
    if (seenPartyKey.has(key)) continue;
    seenPartyKey.add(key);

    const party = partiesById.get(link.partyId);
    if (!party.fullName) continue;

    // Pull DOB / nationality from the source-of-truth CH item when we have
    // it (matched by normalised name — same trick the resolver uses).
    const sourceItem =
      link.role === 'officer'
        ? officersByName.get(normalizeName(party.fullName))
        : link.role === 'psc'
          ? pscByName.get(normalizeName(party.fullName))
          : null;

    const kind = party.partyType === 'organisation' ? 'corporate' : 'individual';
    const subjectName = party.fullName;
    const role = sourceItem?.officer_role || undefined;

    subjects.push({
      id: `party:${party.id}`,
      partyId: party.id,
      name: subjectName,
      normalizedName: normalizeName(subjectName),
      kind,
      source: link.role,
      dob: sourceItem ? pickDob(sourceItem) : undefined,
      nationality: sourceItem ? pickNationality(sourceItem) : undefined,
      role,
    });
  }

  return subjects;
}

const compileScreeningList = withFragment('compile_screening_list', async function compileScreeningList(
  state,
) {
  // Phase 2 fast path: resolver ran and produced parties. Build subjects
  // from those so screening_hits.party_id gets populated.
  if (Array.isArray(state.partyLinks) && state.partyLinks.length) {
    const subjects = await compileSubjectsFromParties(state);
    const counts = subjects.reduce(
      (acc, s) => {
        acc[s.source] = (acc[s.source] || 0) + 1;
        return acc;
      },
      { profile: 0, officer: 0, psc: 0, shareholder: 0 },
    );
    const summary = `Compiled ${subjects.length} party-keyed subjects (${counts.profile} company, ${counts.officer} officers, ${counts.psc} PSCs, ${counts.shareholder} shareholders)`;
    return {
      screeningSubjects: subjects,
      trace: [
        traceEvent('compile_screening_list', summary, {
          total: subjects.length,
          ...counts,
          partyKeyed: true,
        }),
      ],
      __fragment: {
        summary,
        inputs: {
          partyLinkCount: state.partyLinks.length,
          partyCount: (state.parties || []).length,
        },
        outputs: {
          counts,
          subjects: subjects.map((s) => ({
            id: s.id,
            partyId: s.partyId ?? null,
            name: s.name,
            kind: s.kind,
            source: s.source,
          })),
        },
      },
    };
  }

  // Legacy fallback: no parties on state (e.g. resolver was skipped
  // because dossierId wasn't in config). Behaves exactly as pre-Phase-2.
  const subjects = [];
  const seenIds = new Set();
  const seenNormalized = new Set();

  function add(subject) {
    if (!subject.name) return;
    if (seenIds.has(subject.id)) return;
    seenIds.add(subject.id);
    seenNormalized.add(subject.normalizedName);
    subjects.push(subject);
  }

  // 1. Company itself
  const companyName = state.kycCard?.identity?.name || state.profile?.company_name;
  if (companyName) {
    add(
      makeSubject({
        source: 'profile',
        name: companyName,
        kind: 'company',
      }),
    );
  }

  // 2. Officers (skip resigned)
  const officers = state.officers?.items || [];
  for (const o of officers) {
    if (!o?.name) continue;
    if (o.resigned_on) continue;
    add(
      makeSubject({
        source: 'officer',
        name: o.name,
        kind: 'individual',
        role: o.officer_role,
        dob: pickDob(o),
        nationality: pickNationality(o),
      }),
    );
  }

  // 3. PSCs (skip ceased)
  const pscs = state.psc?.items || [];
  for (const p of pscs) {
    if (!p?.name) continue;
    if (p.ceased_on || p.ceased) continue;
    add(
      makeSubject({
        source: 'psc',
        name: p.name,
        kind: classifyPscKind(p),
        dob: pickDob(p),
        nationality: pickNationality(p),
      }),
    );
  }

  // 4. Shareholders from extracted documents — only those not already a PSC
  const shareholders = state.kycCard?.shareholders || [];
  for (const sh of shareholders) {
    if (!sh?.name) continue;
    const normalized = normalizeName(sh.name);
    if (seenNormalized.has(normalized)) continue;
    add(
      makeSubject({
        source: 'shareholder',
        name: sh.name,
        kind: classifyShareholderKind(sh),
      }),
    );
  }

  const counts = subjects.reduce(
    (acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1;
      return acc;
    },
    { profile: 0, officer: 0, psc: 0, shareholder: 0 },
  );

  const summary = `Compiled ${subjects.length} subjects (${counts.profile} company, ${counts.officer} officers, ${counts.psc} PSCs, ${counts.shareholder} shareholders) [legacy path]`;

  return {
    screeningSubjects: subjects,
    trace: [
      traceEvent('compile_screening_list', summary, {
        total: subjects.length,
        ...counts,
      }),
    ],
    __fragment: {
      summary,
      inputs: {
        hasProfile: !!state.profile,
        officersFromApi: officers.length,
        pscFromApi: pscs.length,
        shareholdersFromCard: shareholders.length,
      },
      outputs: {
        counts,
        subjects: subjects.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          source: s.source,
        })),
      },
    },
  };
});

module.exports = { compileScreeningList };
