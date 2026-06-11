// Party master HTTP surface: matcher, list/detail, screening summary,
// watchlist, cross-dossier overrides, merge, review queue, graph.
//
// Auth model (R1): identity comes from the server-side session via
// readUserId(req) → req.auth.userId; every audit row's called_by/applied_by
// is the verified user. Role guards (CODE_REVIEW §3.2): actions that change
// screening outcomes or party identity (overrides, merge, review-queue
// resolution, watchlist membership) require the reviewer tier; reads and
// the matcher stay analyst-accessible.

const { findMatches } = require('../services/party/matcher');
const { requireRole } = require('../services/auth');
const { recordMatchCall } = require('../services/party/auditLog');
const {
  partyMatchInputSchema,
  partyMergeSchema,
  reviewQueueResolutionSchema,
} = require('../lib/partyMatchSchema');
const { mergeParties, MergeError } = require('../services/party/merge');
const { buildPartyGraph, GraphBuildError } = require('../services/party/graph');
const repo = require('../db/repo');

// UUID v4-ish gate. The route handlers below do a cheap regex check before
// hitting the DB so a malformed :id returns 400 instead of being passed
// to Postgres as a non-UUID literal (which surfaces as a 500).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function register(app, { readUserId }) {
  // NOTE: this literal route MUST be registered before `/api/parties/:id`
  // below — otherwise the param route captures "watchlist" as an :id and the
  // UUID guard 400s before we ever get here. (Same trap the existing
  // /review-queue route arguably falls into; see the route-ordering note.)
  app.get('/api/parties/watchlist', async (req, res, next) => {
    try {
      const items = await repo.listWatchedParties({
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ items, count: items.length });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/parties/match', async (req, res, next) => {
    const parsed = partyMatchInputSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_payload',
        validationErrors: parsed.error.issues,
      });
    }

    const { name, minScore, limit } = parsed.data;
    const calledBy = readUserId(req);

    try {
      const result = await findMatches(
        { name },
        { minScore, limit },
      );

      // Audit write is non-blocking against the response on the happy
      // path: every successful match returns the row, and every zero-match
      // result writes its own zero-count row. We await it because the spec
      // says "no exceptions, even on cache hits / zero matches" — the user
      // can wait an extra ~2ms to know their query is auditable.
      await recordMatchCall({
        inputName: name,
        inputCanonical: result.inputCanonical,
        candidates: result.candidates,
        topScore: result.topScore,
        calledBy,
        source: 'api',
      });

      res.json({
        inputCanonical: result.inputCanonical,
        candidates: result.candidates,
        topScore: result.topScore,
      });
    } catch (err) {
      next(err);
    }
  });

  // Read-only list. Filters:
  //   * q           substring (case-insensitive) on full_name OR name_canonical
  //   * needs_review 'true' | 'false' — coerced from the query string
  //   * dossier_id   restricts to parties linked to this dossier UUID
  //   * limit/offset pagination, clamped (1–200, 0+)
  app.get('/api/parties', async (req, res, next) => {
    try {
      const filters = {
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        limit: req.query.limit != null ? Number(req.query.limit) : undefined,
        offset: req.query.offset != null ? Number(req.query.offset) : undefined,
      };
      if (req.query.needs_review === 'true') filters.needsReview = true;
      if (req.query.needs_review === 'false') filters.needsReview = false;
      if (typeof req.query.dossier_id === 'string') {
        if (!UUID_RE.test(req.query.dossier_id)) {
          return res.status(400).json({ error: 'invalid_dossier_id' });
        }
        filters.dossierId = req.query.dossier_id;
      }

      const rows = await repo.listPartiesPage(filters);
      res.json({ parties: rows, count: rows.length });
    } catch (err) {
      next(err);
    }
  });

  // Phase 4 — Review queue list. MUST be registered before `/api/parties/:id`
  // below — otherwise the param route captures "review-queue" as an :id and the
  // UUID guard 400s before we ever get here. (Same trap as /watchlist above.)
  // Note: POST /api/parties/review-queue/:itemId/resolve is two segments deep
  // so it is unaffected by the ordering and stays with the merge routes below.
  app.get('/api/parties/review-queue', async (req, res, next) => {
    try {
      const items = await repo.listOpenReviewQueueItems({
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      });
      res.json({ items, count: items.length });
    } catch (err) {
      next(err);
    }
  });

  // Party detail. Returns the party + all links (with the joined
  // dossier company number/name) + any open review-queue items pointing
  // at or from this party.
  app.get('/api/parties/:id', async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid_party_id' });
      }
      const detail = await repo.getPartyDetail(req.params.id);
      if (!detail) return res.status(404).json({ error: 'party not found' });
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  // Cross-dossier screening summary for the party page. Aggregates every
  // screening hit carrying this party_id with its evaluation + any
  // party-level override into counts + per-list buckets + enriched rows.
  app.get('/api/parties/:id/screening', async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid_party_id' });
      }
      const party = await repo.findPartyById(req.params.id);
      if (!party) return res.status(404).json({ error: 'party not found' });
      const summary = await repo.getPartyScreeningSummary(req.params.id);
      res.json(summary);
    } catch (err) {
      next(err);
    }
  });

  // Watchlist flag / unflag. POST upserts (idempotent), DELETE removes.
  app.post('/api/parties/:id/watchlist', requireRole('reviewer'), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid_party_id' });
      }
      const party = await repo.findPartyById(req.params.id);
      if (!party) return res.status(404).json({ error: 'party not found' });
      const reason =
        typeof req.body?.reason === 'string' && req.body.reason.trim()
          ? req.body.reason.trim()
          : null;
      const row = await repo.addPartyToWatchlist({
        partyId: req.params.id,
        reason,
        addedBy: readUserId(req),
      });
      res.json({ ok: true, watchlist: row });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/parties/:id/watchlist', requireRole('reviewer'), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid_party_id' });
      }
      const removed = await repo.removePartyFromWatchlist(req.params.id);
      res.json({ ok: true, removed });
    } catch (err) {
      next(err);
    }
  });

  // Phase 3 — Party-level screening overrides.
  //
  // PATCH /api/parties/:id/overrides
  //   body: {
  //     listSource: string,            // 'ofac_sdn' | 'uk_hmt' | 'adverse_media'
  //     listEntryId?: string | null,
  //     evidenceUrl?: string | null,
  //     decision: 'confirmed' | 'dismissed' | null,   // null = clear
  //     reason?: string,
  //   }
  //
  // Upserts (or clears) a row in party_screening_overrides. Any future
  // run that produces a screening_hit for this (party_id, list_source,
  // list_entry_id / evidence_url) applies the override instead of running
  // the LLM evaluation (for adverse media) or in addition to it (for
  // sanctions — LLM still runs as audit trail, but the override decides
  // the final status).
  app.patch('/api/parties/:id/overrides', requireRole('reviewer'), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid_party_id' });
      }
      const party = await repo.findPartyById(req.params.id);
      if (!party) return res.status(404).json({ error: 'party not found' });

      const { listSource, listEntryId, evidenceUrl, decision, reason } = req.body || {};
      if (typeof listSource !== 'string' || !listSource) {
        return res.status(400).json({ error: 'listSource required' });
      }

      const ALLOWED = ['confirmed', 'dismissed', null];
      const d = decision === undefined ? null : decision;
      if (!ALLOWED.includes(d)) {
        return res.status(400).json({
          error: 'decision must be confirmed | dismissed | null',
        });
      }

      const appliedBy = readUserId(req);

      if (d === null) {
        await repo.clearPartyScreeningOverride({
          partyId: party.id,
          listSource,
          listEntryId: listEntryId ?? null,
          evidenceUrl: evidenceUrl ?? null,
        });
        return res.json({ ok: true, override: null });
      }

      const override = await repo.setPartyScreeningOverride({
        partyId: party.id,
        listSource,
        listEntryId: listEntryId ?? null,
        evidenceUrl: evidenceUrl ?? null,
        decision: d,
        reason: reason ?? null,
        appliedBy,
      });
      res.json({ ok: true, override });
    } catch (err) {
      next(err);
    }
  });

  // Phase 4 — Soft-merge. :id is the WINNER; the body specifies the loser.
  // Returns the merge counts. Idempotent: a re-run with the same payload
  // is a no-op (loser's mergedIntoPartyId is already set).
  app.post('/api/parties/:id/merge', requireRole('reviewer'), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid_party_id' });
      }
      const parsed = partyMergeSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'invalid_payload',
          validationErrors: parsed.error.issues,
        });
      }
      const userId = readUserId(req);

      const result = await mergeParties({
        winnerId: req.params.id,
        loserId: parsed.data.mergeFromPartyId,
        reason: parsed.data.reason,
        userId,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof MergeError) {
        const status =
          err.code === 'not_found' ? 404 :
          err.code === 'invalid_state' ? 409 :
          400;
        return res.status(status).json({ error: err.code, message: err.message });
      }
      next(err);
    }
  });

  // Phase 5 — Cross-dossier ownership graph for the party detail page.
  //
  // GET /api/parties/:id/graph?depth=1|2&limit=N
  // Returns Cytoscape-shaped {nodes, edges, counts, centerPartyId}.
  app.get('/api/parties/:id/graph', async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) {
        return res.status(400).json({ error: 'invalid_party_id' });
      }
      const depth = req.query.depth ? Number(req.query.depth) : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const graph = await buildPartyGraph(req.params.id, { depth, limit });
      res.json(graph);
    } catch (err) {
      if (err instanceof GraphBuildError) {
        const status =
          err.code === 'not_found' ? 404 :
          err.code === 'invalid_payload' ? 400 :
          500;
        return res.status(status).json({ error: err.code, message: err.message });
      }
      next(err);
    }
  });

  // Resolve one open review-queue item. action='merge' triggers the merge
  // service (winner = the OTHER side of the pair by default; reviewer can
  // override). action='reject' just flips the queue item's status.
  app.post('/api/parties/review-queue/:itemId/resolve', requireRole('reviewer'), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.itemId)) {
        return res.status(400).json({ error: 'invalid_item_id' });
      }
      const parsed = reviewQueueResolutionSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'invalid_payload',
          validationErrors: parsed.error.issues,
        });
      }
      const item = await repo.getReviewQueueItem(req.params.itemId);
      if (!item) return res.status(404).json({ error: 'item not found' });
      if (item.status !== 'open') {
        return res.status(409).json({
          error: 'invalid_state',
          message: `item already resolved (${item.status})`,
        });
      }

      const userId = readUserId(req);

      if (parsed.data.action === 'reject') {
        const updated = await repo.resolveReviewQueueItem({
          id: item.id,
          status: 'rejected',
          resolvedBy: userId,
          reason: parsed.data.reason ?? null,
        });
        return res.json({ ok: true, item: updated });
      }

      // Merge — pick winner. Default: the candidate side (existing party)
      // is the winner, the new party (item.partyId) is the loser.
      // Reviewer can override via winnerPartyId.
      const winnerId = parsed.data.winnerPartyId || item.candidatePartyId;
      const loserId = winnerId === item.candidatePartyId ? item.partyId : item.candidatePartyId;
      try {
        const merged = await mergeParties({
          winnerId,
          loserId,
          reason: parsed.data.reason,
          userId,
        });
        res.json({ ok: true, item: { ...item, status: 'merged' }, merge: merged });
      } catch (err) {
        if (err instanceof MergeError) {
          const status =
            err.code === 'not_found' ? 404 :
            err.code === 'invalid_state' ? 409 :
            400;
          return res.status(status).json({ error: err.code, message: err.message });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register };
