// Phase 5 — Cross-dossier ownership graph builder.
//
// Given a starting partyId, returns a Cytoscape-shaped { nodes, edges }
// payload representing that party's neighbourhood across dossiers:
//
//   depth = 1 → centre party + every dossier it's linked to (any status).
//   depth = 2 → + every OTHER party on those dossiers (other officers,
//               other PSCs, other shareholders).
//
// Node id conventions (consistent with the in-graph shareholderGraph
// rewrite in resolveParties.js):
//   * party nodes   → "party:<uuid>"
//   * dossier nodes → "dossier:<uuid>"
//
// Edges:
//   * party → dossier  (the party_links row that produced the linkage)
//   * never party → party directly (a party-party relationship is always
//     mediated by a dossier; the dossier-side hop is the truth)
//
// The result is capped at `limit` total nodes (default 50) — depth=2 from
// a hub party can fan out indefinitely. We add nodes in a deterministic
// order: centre → directly linked dossiers (by createdAt asc) → other
// parties on those dossiers (also createdAt asc) so a smaller limit
// truncates the periphery rather than the centre.

const { db } = require('../../db/client');
const { sql } = require('drizzle-orm');

const DEFAULT_DEPTH = 2;
const DEFAULT_LIMIT = 50;
const MAX_DEPTH = 2;
const MAX_LIMIT = 200;

class GraphBuildError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function buildPartyGraph(partyId, { depth = DEFAULT_DEPTH, limit = DEFAULT_LIMIT } = {}) {
  if (!partyId) throw new GraphBuildError('partyId required', 'invalid_payload');
  const d = Math.min(Math.max(Number(depth) || DEFAULT_DEPTH, 1), MAX_DEPTH);
  const lim = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  // Centre party (must exist).
  const centerRows = await db.execute(sql`
    SELECT
      id, full_name, party_type, name_canonical,
      needs_review, merged_into_party_id,
      (SELECT COUNT(DISTINCT pl.dossier_id)::int
         FROM party_links pl WHERE pl.party_id = parties.id) AS linked_dossier_count
    FROM parties
    WHERE id = ${partyId}::uuid
    LIMIT 1
  `);
  const center = centerRows.rows[0];
  if (!center) throw new GraphBuildError('party not found', 'not_found');

  const nodes = [];
  const edges = [];
  const seenNodeIds = new Set();
  let edgeIdx = 0;

  function addNode(node) {
    if (seenNodeIds.has(node.data.id)) return false;
    if (nodes.length >= lim) return false;
    nodes.push(node);
    seenNodeIds.add(node.data.id);
    return true;
  }

  // Centre party always lands first.
  addNode({
    data: {
      id: `party:${center.id}`,
      label: center.full_name,
      kind: center.party_type,
      partyId: center.id,
      isCenter: true,
      needsReview: !!center.needs_review,
      mergedInto: center.merged_into_party_id || null,
      linkedDossierCount: Number(center.linked_dossier_count || 0),
    },
  });

  // --- Depth 1: every dossier linked to the centre party ---------------
  // We pull link rows so each edge knows its role + status + dates.
  const linkRows = await db.execute(sql`
    SELECT
      pl.id AS link_id,
      pl.role,
      pl.role_detail,
      pl.status,
      pl.appointed_on,
      pl.resigned_on,
      pl.notified_on,
      pl.ceased_on,
      d.id AS dossier_id,
      d.company_number,
      d.company_name,
      d.case_status
    FROM party_links pl
    INNER JOIN dossiers d ON d.id = pl.dossier_id
    WHERE pl.party_id = ${partyId}::uuid
    ORDER BY d.created_at ASC
  `);

  const dossierIds = [];
  for (const row of linkRows.rows) {
    const dossierNodeId = `dossier:${row.dossier_id}`;
    if (addNode({
      data: {
        id: dossierNodeId,
        label: row.company_name || row.company_number || row.dossier_id,
        kind: 'dossier',
        dossierId: row.dossier_id,
        companyNumber: row.company_number,
        caseStatus: row.case_status,
      },
    })) {
      dossierIds.push(row.dossier_id);
    }

    // Edge centre party → dossier (only if both nodes present).
    if (seenNodeIds.has(dossierNodeId)) {
      edges.push({
        data: {
          id: `e${edgeIdx++}`,
          source: `party:${center.id}`,
          target: dossierNodeId,
          role: row.role,
          roleDetail: row.role_detail || null,
          status: row.status,
          appointedOn: row.appointed_on || null,
          resignedOn: row.resigned_on || null,
          notifiedOn: row.notified_on || null,
          ceasedOn: row.ceased_on || null,
        },
      });
    }
  }

  // --- Depth 2: every OTHER party on each linked dossier --------------
  if (d >= 2 && dossierIds.length && nodes.length < lim) {
    const dossierIdSet = sql.join(
      dossierIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const otherPartyRows = await db.execute(sql`
      SELECT
        pl.id AS link_id,
        pl.role,
        pl.role_detail,
        pl.status,
        pl.appointed_on,
        pl.resigned_on,
        pl.notified_on,
        pl.ceased_on,
        pl.dossier_id,
        p.id AS party_id,
        p.full_name,
        p.party_type,
        p.needs_review,
        p.merged_into_party_id,
        (SELECT COUNT(DISTINCT pl2.dossier_id)::int
           FROM party_links pl2 WHERE pl2.party_id = p.id) AS linked_dossier_count
      FROM party_links pl
      INNER JOIN parties p ON p.id = pl.party_id
      WHERE pl.dossier_id IN (${dossierIdSet})
        AND pl.party_id <> ${partyId}::uuid
      ORDER BY p.created_at ASC
    `);

    for (const row of otherPartyRows.rows) {
      const partyNodeId = `party:${row.party_id}`;
      addNode({
        data: {
          id: partyNodeId,
          label: row.full_name,
          kind: row.party_type,
          partyId: row.party_id,
          needsReview: !!row.needs_review,
          mergedInto: row.merged_into_party_id || null,
          linkedDossierCount: Number(row.linked_dossier_count || 0),
        },
      });
      // Edge only if both endpoints are in the truncated set.
      const dossierNodeId = `dossier:${row.dossier_id}`;
      if (seenNodeIds.has(partyNodeId) && seenNodeIds.has(dossierNodeId)) {
        edges.push({
          data: {
            id: `e${edgeIdx++}`,
            source: partyNodeId,
            target: dossierNodeId,
            role: row.role,
            roleDetail: row.role_detail || null,
            status: row.status,
            appointedOn: row.appointed_on || null,
            resignedOn: row.resigned_on || null,
            notifiedOn: row.notified_on || null,
            ceasedOn: row.ceased_on || null,
          },
        });
      }
    }
  }

  // Diagnostic counts for the UI / API response.
  const counts = {
    nodes: nodes.length,
    edges: edges.length,
    dossiers: nodes.filter((n) => n.data.kind === 'dossier').length,
    parties: nodes.filter((n) => n.data.kind !== 'dossier').length,
    truncated: false,
  };
  // If we hit the node cap AND there were more candidate rows, flag it.
  if (nodes.length >= lim) counts.truncated = true;

  return {
    centerPartyId: partyId,
    depth: d,
    limit: lim,
    nodes,
    edges,
    counts,
  };
}

module.exports = { buildPartyGraph, GraphBuildError };
