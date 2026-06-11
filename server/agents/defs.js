// Agent definitions — pure metadata, NO node references (graph nodes import
// agents/config.js, which imports this; keeping node functions out of this
// file is what breaks the require cycle).
//
// Each agent declares:
//   id / name / description  — identity (id is the agentStatus + config key)
//   required                 — cannot be disabled in v0.1 (load-bearing)
//   schema                   — Zod schema, server-side authoritative validation
//   defaults                 — full default config body (seeds version 1)
//   fields                   — UI metadata the Settings panel renders forms from
//   io                       — state channels the agent reads/writes. This is
//                              the v0.1 documentation of the transport-agnostic
//                              envelope each agent will get when they become
//                              separately deployable (v0.2); not yet enforced.
//
// Secret-capable fields would carry `secret: true` (none exist yet — vendor
// API keys arrive with the Phase 3 vendor registry; the encrypt/mask plumbing
// in agents/config.js + services/config/secrets.js is already live).

const { z } = require('zod');

const AGENTS = [
  {
    id: 'entity-resolution',
    name: 'Entity resolution',
    description:
      'Searches Companies House, deterministically scores candidates, pauses for user confirmation, then fetches profile / officers / PSC / filing history.',
    required: true,
    schema: z
      .object({
        enabled: z.boolean(),
        autoMatchThreshold: z.number().min(0).max(1),
        autoMatchLead: z.number().min(0).max(1),
        maxCandidates: z.number().int().min(1).max(10),
      })
      .strict(),
    defaults: { enabled: true, autoMatchThreshold: 0.85, autoMatchLead: 0.2, maxCandidates: 5 },
    fields: [
      { key: 'autoMatchThreshold', type: 'number', min: 0, max: 1, step: 0.05, label: 'Auto-match threshold', description: 'Minimum top score for an automatic match (still confirmed by the user).' },
      { key: 'autoMatchLead', type: 'number', min: 0, max: 1, step: 0.05, label: 'Auto-match lead', description: 'How far the top score must be ahead of the runner-up.' },
      { key: 'maxCandidates', type: 'number', min: 1, max: 10, step: 1, label: 'Candidates shown', description: 'How many candidates the disambiguation list shows.' },
    ],
    io: {
      reads: ['input'],
      writes: ['candidates', 'resolution', 'companyNumber', 'profile', 'officers', 'psc', 'filingHistory'],
    },
  },
  {
    id: 'document-manager',
    name: 'Document manager',
    description:
      'Selects the latest filing per category, downloads the PDFs, extracts text or OCRs pages, and runs structured extraction.',
    required: false,
    schema: z
      .object({
        enabled: z.boolean(),
        pageCapEnabled: z.boolean(),
        pageCap: z.number().int().min(1).max(50),
        pageSelection: z.enum(['relevance', 'first']),
      })
      .strict(),
    defaults: { enabled: true, pageCapEnabled: true, pageCap: 5, pageSelection: 'relevance' },
    fields: [
      { key: 'pageCapEnabled', type: 'boolean', label: 'OCR page limit', description: 'Cap how many pages per document get the OCR budget. Disable to OCR every page (slow).' },
      { key: 'pageCap', type: 'number', min: 1, max: 50, step: 1, label: 'Max OCR pages', description: 'Pages per document when the limit is on.' },
      { key: 'pageSelection', type: 'select', options: ['relevance', 'first'], label: 'Page selection', description: 'relevance: keyword-score the text layer to pick pages; first: take the first N.' },
    ],
    io: {
      reads: ['companyNumber', 'filingHistory'],
      writes: ['documents'],
    },
  },
  {
    id: 'ubo-structure',
    name: 'UBO & shareholder structure',
    description:
      'Resolves every officer / PSC / shareholder into the cross-dossier party master and rewrites the ownership graph to party identities.',
    required: false,
    schema: z
      .object({
        enabled: z.boolean(),
        requireCorroboration: z.boolean(),
      })
      .strict(),
    defaults: { enabled: true, requireCorroboration: true },
    fields: [
      { key: 'requireCorroboration', type: 'boolean', label: 'Corroboration gate', description: 'Require DOB/nationality corroboration before auto-linking an individual on an exact name match.' },
    ],
    io: {
      reads: ['officers', 'psc', 'kycCard', 'shareholderGraph'],
      writes: ['parties', 'partyLinks', 'shareholderGraph'],
    },
  },
  {
    id: 'screening',
    name: 'Screening',
    description:
      'Screens every subject against cached sanctions lists (OFAC SDN, UK HMT) and live adverse media, with per-hit LLM evaluation.',
    required: false,
    schema: z
      .object({
        enabled: z.boolean(),
        adverseMediaEnabled: z.boolean(),
        gdeltTimespan: z.string().regex(/^\d+[a-z]{1,6}$/i, 'e.g. 12m, 24m, 1y'),
      })
      .strict(),
    defaults: { enabled: true, adverseMediaEnabled: true, gdeltTimespan: '12m' },
    fields: [
      { key: 'adverseMediaEnabled', type: 'boolean', label: 'Adverse media', description: 'Screen individuals against GDELT news. Sanctions screening is unaffected.' },
      { key: 'gdeltTimespan', type: 'string', label: 'News window', description: 'GDELT rolling window, e.g. 12m, 24m.' },
    ],
    io: {
      reads: ['profile', 'officers', 'psc', 'kycCard', 'parties', 'partyLinks'],
      writes: ['screeningSubjects', 'screeningHits', 'screeningEvaluations', 'screeningReport'],
    },
  },
  {
    id: 'risk-assessment',
    name: 'Risk assessment',
    description:
      'Deterministic weighted-factor risk score (geography / entity type / structure / industry) with screening knockouts and an LLM rationale. Thresholds and weights live in the risk matrix (Settings → Risk matrix).',
    required: false,
    schema: z.object({ enabled: z.boolean() }).strict(),
    defaults: { enabled: true },
    fields: [],
    io: {
      reads: ['profile', 'psc', 'kycCard', 'screeningReport'],
      writes: ['riskAssessment'],
    },
  },
  {
    id: 'qa',
    name: 'Quality assurance',
    description:
      'Pure completeness + consistency gate that routes the case (auto-approve / streamlined / standard review) and writes the regulator-style narrative.',
    required: false,
    schema: z.object({ enabled: z.boolean() }).strict(),
    defaults: { enabled: true },
    fields: [],
    io: {
      reads: ['profile', 'kycCard', 'parties', 'partyLinks', 'screeningReport', 'riskAssessment', 'documents', 'agentStatus'],
      writes: ['qaResult', 'qaNarrative'],
    },
  },
];

const byId = new Map(AGENTS.map((a) => [a.id, a]));

function getAgentDef(id) {
  const def = byId.get(id);
  if (!def) throw new Error(`Unknown agent id: ${id}`);
  return def;
}

function listAgentDefs() {
  return AGENTS;
}

// Fields whose values are stored encrypted (none today; Phase 3 vendor keys).
function secretFieldKeys(def) {
  return (def.fields || []).filter((f) => f.secret).map((f) => f.key);
}

module.exports = { AGENTS, getAgentDef, listAgentDefs, secretFieldKeys };
