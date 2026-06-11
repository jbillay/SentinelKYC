// Phase 2 — resolve_parties graph node.
//
// Sits between synthesize_card and compile_screening_list. Calls the
// resolver service (services/party/resolver.js) with the CH inputs that
// fetch_apis produced + the document-extracted shareholders that
// synthesize_card produced. Writes party / link / status_history /
// review_queue rows to Postgres; emits a single decision-kind fragment
// summarising the outcome.
//
// State output:
//   * parties: Array<{id, partyType, fullName, ...}> — every party touched
//     by this run (existing or newly created), in the order they were
//     resolved (officers → PSCs → shareholders).
//   * partyLinks: Array<{id, partyId, role, status, dates}> — every link
//     written this run.
//   * shareholderGraph: rewritten to use `party:<uuid>` node IDs (post-
//     resolver — the synthesize_card builder uses the legacy
//     normalized-name IDs, and we map them to party IDs here using the
//     resolver's outputs).
//
// The node is a no-op when run inside the screening-only graph: that graph
// is seeded by the rescreen route with a profile / officers / psc snapshot
// from the prior run, and the resolver MUST run there too so cross-dossier
// dedup happens on rescreen as well.

const repo = require('../../db/repo');
const { resolveParties } = require('../../services/party/resolver');
const { traceEvent } = require('../state');
const { withFragment } = require('../fragments');
const { ensureRunIdentity } = require('./_identity');

// Build a normalisedName → partyId index for the post-resolver
// shareholder-graph rewrite. The resolver returns parties keyed by id
// only; we need to look up each party's name_canonical to map graph
// node IDs (synthesize_card emits `o:|p:|s:<normalizedName>`).
//
// Cheaper than a per-node DB hit: batch-fetch the touched parties once
// via repo.findPartyById in parallel.
async function fetchTouchedParties(partyIds) {
  if (!partyIds.length) return new Map();
  // findPartyById is single-row; cheap to parallelise for tens of rows.
  const rows = await Promise.all(partyIds.map((id) => repo.findPartyById(id)));
  const map = new Map();
  for (const r of rows) {
    if (r) map.set(r.id, r);
  }
  return map;
}

// Rewrite a shareholderGraph from synthesize_card to use party:<uuid> IDs
// for any node whose normalised name matches a party we just resolved, and
// collapse multiple legacy nodes that resolve to the same person into a
// single node (so an officer + PSC + shareholder who are the same human
// render as one box with all their edges attached). Label + kind are taken
// from the party row — the surface form synthesizeCard happened to pick
// first doesn't matter.
//
// Nodes not matched (corporate shareholders whose names didn't trigger a
// PSC/officer in this run) keep their legacy ID — they still render
// correctly in Cytoscape and Phase 5's cross-dossier traversal only
// follows party-prefixed IDs.
function rewriteShareholderGraph(graph, canonicalToPartyId, partyRowsById) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return graph;
  }
  const { nameCanonical, canonicalTokens, isStrictSubset } = require('../../services/party/canonical');

  // Phase 1 — map each person/org node to the party it resolved to, by
  // canonical-name equality. Crucially this uses the SAME canonical form as
  // the party master (nameCanonical: honorific-stripped + token-sorted), so a
  // title-bearing surface form like "Mr Vincent Huard" lands on the same key
  // as its party ("benjamin huard matthieu vincent") and collapses onto it.
  // (The previous normaliser left the honorific in, so every "Mr/Mrs ..." PSC
  // node failed to match and rendered as a duplicate.)
  const remap = new Map(); // old node id → new node id
  const nodeMeta = []; // { oldId, kind, tokens, partyId } for the subset pass
  for (const node of graph.nodes) {
    const oldId = node?.data?.id;
    if (!oldId) continue;
    // The company node uses a `co:<companyNumber>` prefix — leave it alone.
    if (oldId.startsWith('co:')) continue;
    const label = node?.data?.label;
    if (!label) continue;
    const partyId = canonicalToPartyId.get(nameCanonical(label)) || null;
    if (partyId) remap.set(oldId, `party:${partyId}`);
    nodeMeta.push({ oldId, kind: node?.data?.kind, tokens: canonicalTokens(label), partyId });
  }

  // Phase 2 — fold partial-name individuals onto their full-name twin.
  // A confirmation-statement OCR yields "Vincent Huard"; Companies House
  // yields "Vincent Matthieu Benjamin Huard". The resolver (correctly) keeps
  // these as separate party rows — a partial name is not an EXACT match, and
  // the KYC master must never silently merge identities. But on the GRAPH they
  // are visibly the same human, so we collapse them here at the DISPLAY layer
  // only. Individuals only; the subset side must have ≥2 tokens (see
  // isStrictSubset) so a lone forename/surname can't absorb an unrelated name.
  const individuals = nodeMeta.filter((m) => m.kind === 'individual' && m.tokens.length >= 2);
  for (const sub of individuals) {
    let best = null;
    for (const sup of individuals) {
      if (sup === sub) continue;
      if (!isStrictSubset(sub.tokens, sup.tokens)) continue;
      // Prefer the richest superset; on a tie prefer a party-backed one so the
      // merged node keeps a party:<uuid> id.
      if (
        !best ||
        sup.tokens.length > best.tokens.length ||
        (sup.tokens.length === best.tokens.length && !!sup.partyId && !best.partyId)
      ) {
        best = sup;
      }
    }
    if (best) remap.set(sub.oldId, best.oldId);
  }

  if (remap.size === 0) return graph;

  // Flatten any remap chains (a subset may point at a node that itself was
  // remapped to a party) so every node resolves to its terminal id in one hop.
  const resolveFinal = (id) => {
    const seen = new Set();
    let cur = id;
    while (remap.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = remap.get(cur);
    }
    return cur;
  };

  // Dedupe nodes by their terminal id. For party-backed nodes, override the
  // label and kind from the party row so the merged node carries a single
  // canonical identity regardless of which legacy surface form (officer
  // "SMITH, John" vs PSC "Mr John Smith") synthesizeCard emitted first.
  const seen = new Set();
  const newNodes = [];
  for (const n of graph.nodes) {
    const oldId = n?.data?.id;
    const newId = resolveFinal(oldId);
    if (seen.has(newId)) continue;
    seen.add(newId);

    let nextData = { ...n.data, id: newId };
    if (newId.startsWith('party:') && partyRowsById) {
      const partyId = newId.slice('party:'.length);
      const party = partyRowsById.get(partyId);
      if (party?.fullName) nextData.label = party.fullName;
      if (party?.partyType === 'organisation') nextData.kind = 'corporate';
      else if (party?.partyType === 'individual') nextData.kind = 'individual';
    }
    newNodes.push({ ...n, data: nextData });
  }

  const newEdges = graph.edges.map((e) => {
    const src = e?.data?.source;
    const tgt = e?.data?.target;
    const newSrc = resolveFinal(src);
    const newTgt = resolveFinal(tgt);
    if (newSrc === src && newTgt === tgt) return e;
    return { ...e, data: { ...e.data, source: newSrc, target: newTgt } };
  });

  return { nodes: newNodes, edges: newEdges };
}

// Build a canonical-name → partyId index for the graph rewrite. Keyed by the
// party master's stored name_canonical (the authoritative SQL value) AND by a
// JS recomputation from fullName via the shared canonicaliser — the two agree
// for Latin names, and keying on both is cheap defence in depth. The same
// canonicaliser (services/party/canonical.js) is used to canonicalise the
// graph node labels on lookup, so honorifics / token order / punctuation can't
// cause a surface form to miss its party.
function buildCanonicalIndex(partyRows) {
  const { nameCanonical } = require('../../services/party/canonical');
  const idx = new Map();
  for (const p of partyRows.values()) {
    if (p?.nameCanonical) idx.set(p.nameCanonical, p.id);
    const altKey = nameCanonical(p.fullName);
    if (altKey) idx.set(altKey, p.id);
  }
  return idx;
}

const resolveParties_node = withFragment(
  'resolve_parties',
  async function resolveParties_node(state, config) {
    // R4a — identity preference order lives in ensureRunIdentity (state →
    // config → DB-by-thread_id → dossier-by-companyNumber). The resolved ids
    // are returned in this node's partial state so downstream nodes hit the
    // cheap state branch.
    const { dossierId, runId } = await ensureRunIdentity(state, config);

    if (!dossierId) {
      // No dossier context (very early run before the SSE writer assigned
      // one, or a synthetic state) — skip rather than fail. The screening
      // path will fall back to its legacy non-party subject IDs.
      return {
        trace: [traceEvent('resolve_parties', 'no dossierId in config, skipping')],
        __fragment: {
          status: 'skipped',
          summary: 'No dossierId in graph config — resolver skipped',
        },
      };
    }

    const officers = state.officers?.items || [];
    const pscItems = state.psc?.items || [];
    const shareholders = state.kycCard?.shareholders || [];

    const result = await resolveParties({
      dossierId,
      runId,
      profile: state.profile,
      officers,
      psc: pscItems,
      shareholders,
      matchLogSource: 'resolver',
      matchLogCalledBy: `system:resolve_parties:${runId || 'no-run'}`,
    });

    // Project resolver output into the slim state shapes (so downstream
    // nodes can consume without re-fetching).
    const touchedPartyIds = Array.from(new Set(result.parties.map((p) => p.id)));
    const partyRows = await fetchTouchedParties(touchedPartyIds);
    const partiesState = Array.from(partyRows.values()).map((p) => ({
      id: p.id,
      partyType: p.partyType,
      fullName: p.fullName,
      needsReview: p.needsReview ?? false,
      nameCanonical: p.nameCanonical ?? undefined,
      chOfficerAppointmentId: p.chOfficerAppointmentId ?? null,
      registrationNumber: p.registrationNumber ?? null,
      registrationCountry: p.registrationCountry ?? null,
      dossierId: p.dossierId ?? null,
    }));

    const partyLinksState = result.links.map((l) => ({
      id: l.id,
      partyId: l.party_id,
      role: l.role,
      status: l.status,
      appointedOn: l.appointed_on ?? null,
      resignedOn: l.resigned_on ?? null,
      notifiedOn: l.notified_on ?? null,
      ceasedOn: l.ceased_on ?? null,
    }));

    // Rewrite the existing shareholderGraph to use party:<uuid> IDs and
    // collapse duplicate person nodes (officer + PSC of the same human).
    const canonicalToPartyId = buildCanonicalIndex(partyRows);
    const newShareholderGraph = state.shareholderGraph
      ? rewriteShareholderGraph(state.shareholderGraph, canonicalToPartyId, partyRows)
      : state.shareholderGraph;

    const summary =
      `Resolved ${result.counts.officers} officers + ${result.counts.psc} PSCs + ${result.counts.shareholders} shareholders → ` +
      `${result.counts.newParties} new ${result.counts.newParties === 1 ? 'party' : 'parties'}, ` +
      `${result.counts.autoLinkedStrong} strong-key, ${result.counts.autoLinkedExact} EXACT-name ` +
      `(${result.counts.autoLinkedCorroborated} corroborated), ` +
      `${result.counts.exactDemotedToReview} EXACT demoted to review, ` +
      `${result.counts.queuedForReview} queued for review, ` +
      `${result.counts.historicalReconciled} historical reconciled`;

    return {
      dossierId,
      runId,
      parties: partiesState,
      partyLinks: partyLinksState,
      shareholderGraph: newShareholderGraph,
      trace: [
        traceEvent('resolve_parties', summary, {
          ...result.counts,
        }),
      ],
      __fragment: {
        summary,
        inputs: {
          dossierId,
          runId,
          officersFromApi: officers.length,
          pscFromApi: pscItems.length,
          shareholdersFromCard: shareholders.length,
        },
        outputs: {
          ...result.counts,
          partyIds: touchedPartyIds,
          linkIds: result.links.map((l) => l.id),
          reviewQueueItemIds: result.reviewItems.map((r) => r.id),
        },
      },
    };
  },
);

module.exports = {
  resolveParties: resolveParties_node,
  // Exported for unit-level / smoke testing of the pure graph-rewrite helpers
  // (no DB access — safe to call in isolation).
  _rewriteShareholderGraph: rewriteShareholderGraph,
  _buildCanonicalIndex: buildCanonicalIndex,
};
