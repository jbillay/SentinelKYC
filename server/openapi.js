// OpenAPI 3.0 description of the SentinelKYC API — served interactively at
// /api/docs (Swagger UI) and as JSON at /api/docs/openapi.json.
//
// Hand-maintained for v0.1: paths carry accurate methods/params/summaries;
// request/response bodies are documented at the shape level (full Zod→OpenAPI
// schema generation is a later hardening step). When you add or change a
// route, update this file in the same PR.

const { REASON_CODES } = require('./lib/decisionSchema');

function p(summary, extra = {}) {
  return { summary, ...extra };
}

const cnParam = {
  name: 'companyNumber',
  in: 'path',
  required: true,
  schema: { type: 'string' },
  description: 'UK company number (e.g. 00214436)',
};
const runIdParam = { name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const threadIdParam = { name: 'threadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };

const jsonBody = (schema, description) => ({
  required: true,
  description,
  content: { 'application/json': { schema } },
});

const okJson = { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } };

function buildSpec() {
  return {
    openapi: '3.0.3',
    info: {
      title: 'SentinelKYC API',
      version: '0.1.0',
      description:
        'Agentic KYC for UK companies. Cookie-session auth (`POST /api/auth/login`); ' +
        'mutating requests need the CSRF token from `GET /api/auth/csrf` echoed in `x-csrf-token`. ' +
        'Roles: analyst < reviewer < admin.',
    },
    servers: [{ url: '/', description: 'Same origin' }],
    tags: [
      { name: 'auth' }, { name: 'runs' }, { name: 'dossiers' }, { name: 'screening' },
      { name: 'risk' }, { name: 'qa' }, { name: 'decision' }, { name: 'parties' },
      { name: 'agents' }, { name: 'admin' }, { name: 'prompts' }, { name: 'documents' }, { name: 'meta' }, { name: 'health' },
    ],
    components: {
      securitySchemes: {
        session: { type: 'apiKey', in: 'cookie', name: 'ccpoc.sid', description: 'Server-side session cookie' },
        csrf: { type: 'apiKey', in: 'header', name: 'x-csrf-token', description: 'Double-submit CSRF token (mutating requests)' },
      },
      schemas: {
        DecisionPayload: {
          type: 'object',
          description: 'Discriminated union on `action`. userId comes from the session; a body userId is ignored.',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['approve', 'reject', 'escalate', 'request_info'] },
            reasonCode: { type: 'string', enum: REASON_CODES, description: 'reject only' },
            freeText: { type: 'string', minLength: 10, description: 'reject only' },
            notes: { type: 'string', minLength: 10, description: 'escalate only' },
            suggestedAction: { type: 'string', description: 'escalate only (optional)' },
            items: {
              type: 'array',
              description: 'request_info only',
              items: {
                type: 'object',
                required: ['description', 'category'],
                properties: { description: { type: 'string', minLength: 3 }, category: { type: 'string', minLength: 1 } },
              },
            },
          },
        },
        AgentConfigSave: {
          type: 'object',
          required: ['body'],
          properties: {
            body: { type: 'object', description: "Full config body validated against the agent's schema" },
            notes: { type: 'string', nullable: true },
          },
        },
      },
    },
    security: [{ session: [] }],
    paths: {
      // --- auth ------------------------------------------------------------
      '/api/auth/login': { post: p('Sign in (rate-limited)', { tags: ['auth'], security: [], requestBody: jsonBody({ type: 'object', required: ['username', 'password'], properties: { username: { type: 'string' }, password: { type: 'string' } } }), responses: okJson }) },
      '/api/auth/logout': { post: p('Sign out', { tags: ['auth'], responses: okJson }) },
      '/api/auth/me': { get: p('Current user (id, username, displayName, email, role)', { tags: ['auth'], responses: okJson }) },
      '/api/auth/csrf': { get: p('Fetch the CSRF token for mutating requests', { tags: ['auth'], responses: okJson }) },
      '/api/auth/profile': { patch: p('Update own displayName / username / email', { tags: ['auth'], requestBody: jsonBody({ type: 'object' }), responses: okJson }) },
      '/api/auth/password': { post: p('Change own password (current password required)', { tags: ['auth'], requestBody: jsonBody({ type: 'object', required: ['currentPassword', 'newPassword'] , properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string', minLength: 8 } } }), responses: okJson }) },

      // --- runs ------------------------------------------------------------
      '/api/run': { post: p('Start a fresh KYC run → { threadId }', { tags: ['runs'], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, companyNumber: { type: 'string' }, postcode: { type: 'string' }, incorporationYear: { type: 'integer' } } }, 'name or companyNumber required'), responses: okJson }) },
      '/api/stream/{threadId}': { get: p('SSE stream of run events (progress / trace / fragment / interrupt / done …)', { tags: ['runs'], parameters: [threadIdParam], responses: { 200: { description: 'text/event-stream' } } }) },
      '/api/resume/{threadId}': { post: p('Resume after the entity-selection interrupt', { tags: ['runs'], parameters: [threadIdParam], requestBody: jsonBody({ type: 'object', required: ['companyNumber'], properties: { companyNumber: { type: 'string' } } }), responses: okJson }) },
      '/api/cancel/{threadId}': { post: p('Cancel a running run', { tags: ['runs'], parameters: [threadIdParam], responses: okJson }) },
      '/api/runs/active': { get: p('Currently running runs', { tags: ['runs'], responses: okJson }) },

      // --- dossiers ----------------------------------------------------------
      '/api/dossiers': { get: p('List dossiers (+KPIs via /api/dossiers/kpis)', { tags: ['dossiers'], responses: okJson }) },
      '/api/dossiers/kpis': { get: p('Dossier KPI rollup', { tags: ['dossiers'], responses: okJson }) },
      '/api/dossiers/{companyNumber}': {
        get: p('Dossier detail (historical runs are lean)', { tags: ['dossiers'], parameters: [cnParam], responses: okJson }),
        patch: p('Update tags / notes', { tags: ['dossiers'], parameters: [cnParam], requestBody: jsonBody({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } }), responses: okJson }),
      },
      '/api/dossiers/{companyNumber}/refresh': { post: p('Full re-run (fresh CH + OCR + screening) → { threadId }', { tags: ['dossiers'], parameters: [cnParam], responses: okJson }) },
      '/api/dossiers/{companyNumber}/rescreen': { post: p('Screening-only re-run seeded from the latest run → { threadId }', { tags: ['dossiers'], parameters: [cnParam], responses: okJson }) },
      '/api/dossiers/{companyNumber}/runs/{runId}': { get: p('Frozen run detail', { tags: ['dossiers'], parameters: [cnParam, runIdParam], responses: okJson }) },
      '/api/dossiers/{companyNumber}/runs/{runId}/export.json': { get: p('Full run export as a downloadable JSON document', { tags: ['dossiers'], parameters: [cnParam, runIdParam], responses: okJson }) },
      '/api/dossiers/{companyNumber}/runs/{runId}/resume': { post: p('Re-run a failed run from its checkpoint', { tags: ['dossiers'], parameters: [cnParam, runIdParam], responses: okJson }) },
      '/api/audit': { get: p('Human-action decision-fragment feed (?kind=human_action&limit=200)', { tags: ['dossiers'], responses: okJson }) },

      // --- screening ---------------------------------------------------------
      '/api/dossiers/{companyNumber}/runs/{runId}/screening': { get: p('Full screening hits + evaluations for a run', { tags: ['screening'], parameters: [cnParam, runIdParam], responses: okJson }) },
      '/api/dossiers/{companyNumber}/runs/{runId}/hits/{hitId}': { patch: p('Set/clear a human override on a hit (reviewer); null decision clears', { tags: ['screening'], parameters: [cnParam, runIdParam, { name: 'hitId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ type: 'object', properties: { decision: { type: 'string', enum: ['confirmed', 'dismissed', 'needs_review'], nullable: true }, reason: { type: 'string', nullable: true } } }), responses: okJson }) },
      '/api/dossiers/{companyNumber}/runs/{runId}/carry-overrides-forward': { post: p('Copy run overrides to dossier-level (reviewer)', { tags: ['screening'], parameters: [cnParam, runIdParam], responses: okJson }) },
      '/api/screening/lists': { get: p('Loaded sanctions list versions', { tags: ['screening'], responses: okJson }) },

      // --- risk ---------------------------------------------------------------
      '/api/risk/matrix': { get: p('Active risk matrix', { tags: ['risk'], responses: okJson }) },
      '/api/risk/matrix/versions': { get: p('Matrix version history', { tags: ['risk'], responses: okJson }), post: p('Create a matrix version (admin; does not activate)', { tags: ['risk'], requestBody: jsonBody({ type: 'object' }), responses: okJson }) },
      '/api/risk/matrix/versions/{id}': { get: p('One matrix version incl. its body', { tags: ['risk'], parameters: [idParam], responses: okJson }) },
      '/api/risk/matrix/active': { post: p('Activate a matrix version (admin)', { tags: ['risk'], requestBody: jsonBody({ type: 'object', required: ['versionId'], properties: { versionId: { type: 'string' } } }), responses: okJson }) },
      '/api/dossiers/{companyNumber}/runs/{runId}/risk': { get: p('Frozen risk assessment for a run', { tags: ['risk'], parameters: [cnParam, runIdParam], responses: okJson }) },
      '/api/dossiers/{companyNumber}/recalculate-risk': { post: p('Matrix-edit-only risk rebase of the latest run (no new run)', { tags: ['risk'], parameters: [cnParam], responses: okJson }) },

      // --- qa / decision -------------------------------------------------------
      '/api/dossiers/{companyNumber}/runs/{runId}/qa': { get: p('Frozen QA result', { tags: ['qa'], parameters: [cnParam, runIdParam], responses: okJson }) },
      '/api/dossiers/{companyNumber}/runs/{runId}/qa/recompute': { post: p('Engine-rebase QA against stored snapshots', { tags: ['qa'], parameters: [cnParam, runIdParam], responses: okJson }) },
      '/api/dossiers/{companyNumber}/runs/{runId}/decision': { post: p('Apply the final reviewer decision, then resume the graph (reviewer)', { tags: ['decision'], parameters: [cnParam, runIdParam], requestBody: jsonBody({ $ref: '#/components/schemas/DecisionPayload' }), responses: { ...okJson, 409: { description: 'invalid_transition' } } }) },

      // --- parties --------------------------------------------------------------
      '/api/parties': { get: p('Party master list (?q=&needs_review=&dossier_id=, paginated)', { tags: ['parties'], responses: okJson }) },
      '/api/parties/match': { post: p('Name matcher (always logs a party_match_log row)', { tags: ['parties'], requestBody: jsonBody({ type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 500 }, dob: { type: 'object', properties: { year: { type: 'integer' }, month: { type: 'integer' } } }, nationality: { type: 'array', items: { type: 'string', description: 'ISO-3166-1 alpha-2' } }, countryOfResidence: { type: 'string', description: 'ISO-3166-1 alpha-2' }, minScore: { type: 'number', minimum: 0, maximum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } }), responses: okJson }) },
      '/api/parties/watchlist': { get: p('Watched parties', { tags: ['parties'], responses: okJson }) },
      '/api/parties/review-queue': { get: p('Pending dedup review items', { tags: ['parties'], responses: okJson }) },
      '/api/parties/review-queue/{itemId}/resolve': { post: p('Resolve a review-queue item (reviewer): merge the pair or reject', { tags: ['parties'], parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], requestBody: jsonBody({ type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['merge', 'reject'] }, winnerPartyId: { type: 'string', format: 'uuid', description: 'merge only (optional) — overrides the default merge direction' }, reason: { type: 'string', minLength: 3, maxLength: 500 } } }), responses: { ...okJson, 409: { description: 'invalid_state (item already resolved)' } } }) },
      '/api/parties/{id}': { get: p('Party detail', { tags: ['parties'], parameters: [idParam], responses: okJson }) },
      '/api/parties/{id}/screening': { get: p('Cross-dossier screening summary for a party', { tags: ['parties'], parameters: [idParam], responses: okJson }) },
      '/api/parties/{id}/graph': { get: p('Cytoscape graph centred on a party (?depth=&limit=)', { tags: ['parties'], parameters: [idParam], responses: okJson }) },
      '/api/parties/{id}/overrides': { patch: p('Party-level (cross-dossier) screening override (reviewer); null decision clears', { tags: ['parties'], parameters: [idParam], requestBody: jsonBody({ type: 'object', required: ['listSource'], properties: { listSource: { type: 'string' }, listEntryId: { type: 'string', nullable: true }, evidenceUrl: { type: 'string', nullable: true }, decision: { type: 'string', enum: ['confirmed', 'dismissed'], nullable: true }, reason: { type: 'string', nullable: true } } }), responses: okJson }) },
      '/api/parties/{id}/merge': { post: p('Soft-merge another party into this one (reviewer; :id wins)', { tags: ['parties'], parameters: [idParam], requestBody: jsonBody({ type: 'object', required: ['mergeFromPartyId'], properties: { mergeFromPartyId: { type: 'string', format: 'uuid', description: 'the losing party' }, reason: { type: 'string', minLength: 3, maxLength: 500 } } }), responses: { ...okJson, 409: { description: 'invalid_state' } } }) },
      '/api/parties/{id}/watchlist': {
        post: p('Add to watchlist (reviewer)', { tags: ['parties'], parameters: [idParam], responses: okJson }),
        delete: p('Remove from watchlist (reviewer)', { tags: ['parties'], parameters: [idParam], responses: okJson }),
      },

      // --- agents ------------------------------------------------------------
      '/api/agents': { get: p('Agent registry: definition + masked config + version', { tags: ['agents'], responses: okJson }) },
      '/api/agents/{id}': { get: p('Agent detail + config version history', { tags: ['agents'], parameters: [idParam], responses: okJson }) },
      '/api/agents/{id}/config': { post: p('Save agent config — new version, activated, audited (admin)', { tags: ['agents'], parameters: [idParam], requestBody: jsonBody({ $ref: '#/components/schemas/AgentConfigSave' }), responses: { ...okJson, 400: { description: 'invalid_config (validationErrors[])' } } }) },
      '/api/agents/{id}/enabled': { post: p('Enable/disable an agent (admin; required agents refuse)', { tags: ['agents'], parameters: [idParam], requestBody: jsonBody({ type: 'object', required: ['enabled'], properties: { enabled: { type: 'boolean' } } }), responses: okJson }) },

      // --- admin ----------------------------------------------------------------
      '/api/admin/users': { get: p('Members list — application users, safe fields only (admin)', { tags: ['admin'], responses: { ...okJson, 403: { description: 'forbidden (non-admin)' } } }) },

      // --- prompts --------------------------------------------------------------
      '/api/prompts': { get: p('Prompt registry keys + owning agent + active/latest versions', { tags: ['prompts'], responses: okJson }) },
      '/api/prompts/{key}': { get: p('Prompt detail (incl. owning agent) + version history', { tags: ['prompts'], parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], responses: okJson }) },
      '/api/prompts/{key}/versions/{id}': { get: p('One prompt version incl. its body (A/B baseline for the eval harness)', { tags: ['prompts'], parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }, idParam], responses: okJson }) },
      '/api/prompts/{key}/versions': { post: p('Create a prompt version (admin; does not activate)', { tags: ['prompts'], parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ type: 'object', required: ['body'], properties: { body: { type: 'string' }, notes: { type: 'string' } } }), responses: okJson }) },
      '/api/prompts/{key}/active': { post: p('Activate a prompt version (admin)', { tags: ['prompts'], parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }], requestBody: jsonBody({ type: 'object', required: ['versionId'], properties: { versionId: { type: 'string' } } }), responses: okJson }) },

      // --- documents / meta / health ---------------------------------------------
      '/api/documents/{documentId}': { get: p('Inline filing PDF proxy (CH Document API)', { tags: ['documents'], parameters: [{ name: 'documentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'application/pdf' } } }) },
      '/api/health': { get: p('LLM provider probe + per-agent enablement (public)', { tags: ['health'], security: [], responses: okJson }) },
      '/api/metrics': { get: p('In-process counters/histograms', { tags: ['meta'], responses: okJson }) },
      '/api/meta/process': { get: p('Live assembled graph topology (mermaid) + enabled agents', { tags: ['meta'], responses: okJson }) },
      '/api/meta/data-model': { get: p('State schema + persisted-table introspection', { tags: ['meta'], responses: okJson }) },
    },
  };
}

module.exports = { buildSpec };
