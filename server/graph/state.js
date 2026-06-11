const { z } = require('zod');
const { withLangGraph } = require('@langchain/langgraph/zod');

const InputSchema = z.object({
  name: z.string().optional(),
  postcode: z.string().optional(),
  incorporationYear: z.number().int().optional(),
  companyNumber: z.string().optional(),
});

const ScoreBreakdownSchema = z.object({
  apiRank: z.number(),
  base: z.number(),
  numberMatch: z.number().default(0),
  postcodeMatch: z.number().default(0),
  yearMatch: z.number().default(0),
  typeMatch: z.number().default(0),
});

const CandidateSchema = z.object({
  companyNumber: z.string(),
  title: z.string(),
  address: z.string().optional(),
  postcode: z.string().optional(),
  status: z.string().optional(),
  incorporationDate: z.string().optional(),
  sicCodes: z.array(z.string()).optional(),
  type: z.string().optional(),
  apiRank: z.number().int(),
  score: z.number(),
  scoreBreakdown: ScoreBreakdownSchema.optional(),
});

const ResolutionStatus = z.enum([
  'auto_match',
  'needs_user_pick',
  'needs_more_info',
  'not_found',
]);

const ResolutionSchema = z.object({
  status: ResolutionStatus,
  chosen: z.string().optional(),
  reason: z.string().optional(),
});

const TraceEventSchema = z.object({
  node: z.string(),
  ts: z.number(),
  msg: z.string(),
  extra: z.record(z.string(), z.any()).optional(),
});

const ErrorEventSchema = z.object({
  node: z.string(),
  message: z.string(),
  ts: z.number(),
});

// Kept in sync with the `fragment_kind` enum in Postgres (see migration 0009).
// `human_action` fragments are written directly via applyDecision and don't
// flow through graph state, but the enum stays aligned so state-resident
// fragments can carry the same kind values without a reducer rejection.
const FragmentKind = z.enum(['decision', 'audit', 'human_action']);
const FragmentStatus = z.enum(['ok', 'failed', 'skipped']);

const DecisionFragmentSchema = z.object({
  id: z.string(),
  parentFragmentId: z.string().nullable().optional(),
  nodeId: z.string(),
  sequence: z.number().int(),
  kind: FragmentKind,
  status: FragmentStatus,
  startedAt: z.number(),
  durationMs: z.number().int().optional(),
  summary: z.string(),
  inputs: z.any().optional(),
  outputs: z.any().optional(),
  error: z.string().optional(),
});

const DocumentStatus = z.enum(['selected', 'downloaded', 'processed', 'failed']);
const ProcessedBy = z.enum(['text', 'ocr', 'failed']);

const DocumentSchema = z.object({
  transactionId: z.string(),
  category: z.string(),
  type: z.string().optional(),
  date: z.string().optional(),
  documentId: z.string().optional(),
  path: z.string().nullable().optional(),
  status: DocumentStatus,
  processedBy: ProcessedBy.optional(),
  extracted: z.any().optional(),
  error: z.string().optional(),
  // X1 — OCR truncation surfacing. A 50-page confirmation statement OCR'd
  // under OCR_PAGE_CAP must say so, loudly: "shareholders dropped" must be
  // distinguishable from "shareholders absent".
  truncated: z.boolean().optional(),
  pagesProcessed: z.number().optional(),
  pagesTotal: z.number().optional(),
  // Which 1-based page numbers were OCR'd (relevance selection may pick
  // pages beyond the first N).
  pagesSelected: z.array(z.number()).optional(),
});

const KycIdentitySchema = z.object({
  name: z.string(),
  companyNumber: z.string(),
  type: z.string().optional(),
  status: z.string().optional(),
  incorporationDate: z.string().optional(),
  countryOfIncorporation: z.string().optional(),
  sicCodes: z.array(z.string()).optional(),
});

const KycAddressSchema = z.object({
  registered: z.string().optional(),
});

const KycOfficerSchema = z.object({
  name: z.string(),
  role: z.string().optional(),
  appointedOn: z.string().optional(),
  resignedOn: z.string().optional(),
});

const KycPscSchema = z.object({
  name: z.string(),
  kind: z.string().optional(),
  naturesOfControl: z.array(z.string()).optional(),
  notifiedOn: z.string().optional(),
});

// R6 — extraction honesty flags, both optional so old data validates.
// `provenance`: where the record came from (api = CH API authoritative,
// text = PDF text layer, ocr = vision-model OCR). `confidence`: the model's
// self-assessment, advisory only — risk/QA engines must never read it.
const Provenance = z.enum(['api', 'text', 'ocr']);
const ExtractionConfidence = z.enum(['high', 'medium', 'low']);

const KycShareholderSchema = z.object({
  name: z.string(),
  type: z.enum(['individual', 'corporate']).optional(),
  shares: z.number().optional(),
  percentage: z.number().optional(),
  shareClass: z.string().optional(),
  provenance: Provenance.optional(),
  confidence: ExtractionConfidence.optional(),
});

const KycFinancialsSchema = z.object({
  periodEnd: z.string().optional(),
  turnover: z.number().optional(),
  profit: z.number().optional(),
  totalAssets: z.number().optional(),
  netAssets: z.number().optional(),
  employees: z.number().optional(),
  provenance: Provenance.optional(),
  confidence: ExtractionConfidence.optional(),
});

const KycDocumentSummarySchema = z.object({
  category: z.string(),
  date: z.string().optional(),
  transactionId: z.string(),
  processedBy: z.string().optional(),
  // X1 — truncation surfacing.
  truncated: z.boolean().optional(),
  pagesProcessed: z.number().optional(),
  pagesTotal: z.number().optional(),
});

const KycCardSchema = z.object({
  identity: KycIdentitySchema,
  addresses: KycAddressSchema.optional(),
  officers: z.array(KycOfficerSchema).default(() => []),
  psc: z.array(KycPscSchema).default(() => []),
  shareholders: z.array(KycShareholderSchema).default(() => []),
  financials: KycFinancialsSchema.optional(),
  documents: z.array(KycDocumentSummarySchema).default(() => []),
  redFlags: z.array(z.string()).default(() => []),
  sourceTrace: z
    .record(
      z.string(),
      z.object({
        source: z.enum(['api', 'doc']),
        kind: z.string().optional(),
        fragmentId: z.string().optional(),
      })
    )
    .default(() => ({})),
});

const GraphNodeSchema = z.object({
  data: z.object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(['company', 'individual', 'corporate']),
  }),
});

const GraphEdgeSchema = z.object({
  data: z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    label: z.string().optional(),
    rel: z.enum(['owns', 'officer']).optional(),
  }),
});

const ShareholderGraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
});

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

const SubjectKind = z.enum(['company', 'individual', 'corporate']);
const SubjectSource = z.enum(['profile', 'officer', 'psc', 'shareholder']);

const SubjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  normalizedName: z.string(),
  kind: SubjectKind,
  source: SubjectSource,
  dob: z.string().optional(),
  nationality: z.array(z.string()).optional(),
  role: z.string().optional(),
  // Phase 2 — populated by compile_screening_list when state.parties is
  // present. The subjectId remains the per-run logical key; partyId is the
  // stable cross-run identifier that screening_hits + party-level overrides
  // pivot on.
  partyId: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Party Master (Phase 2 — populated by resolve_parties node)
// ---------------------------------------------------------------------------
// The shape carried in graph state is intentionally minimal: just the bits
// downstream nodes need to thread party_id through screening + the
// shareholder-graph rewrite. The full party row lives in `parties` in
// Postgres; nodes can re-fetch when they need richer data.

const StatePartySchema = z.object({
  id: z.string(),
  partyType: z.enum(['individual', 'organisation']),
  fullName: z.string(),
  needsReview: z.boolean().optional(),
  // Used by the shareholderGraph rewrite to map normalized names to IDs.
  nameCanonical: z.string().optional(),
  // Strong-key identifiers (when set by the resolver).
  chOfficerAppointmentId: z.string().nullable().optional(),
  registrationNumber: z.string().nullable().optional(),
  registrationCountry: z.string().nullable().optional(),
  // Back-link when this party IS an onboarded company we already know.
  dossierId: z.string().nullable().optional(),
});

const StatePartyLinkSchema = z.object({
  id: z.string(),
  partyId: z.string(),
  role: z.enum(['officer', 'psc', 'shareholder']),
  status: z.enum(['active', 'resigned', 'ceased', 'historical']),
  appointedOn: z.string().nullable().optional(),
  resignedOn: z.string().nullable().optional(),
  notifiedOn: z.string().nullable().optional(),
  ceasedOn: z.string().nullable().optional(),
});

const ListSource = z.enum(['ofac_sdn', 'uk_hmt', 'adverse_media']);

const HitSchema = z.object({
  hitId: z.string(),
  subjectId: z.string(),
  subjectName: z.string(),
  subjectKind: SubjectKind,
  subjectSource: SubjectSource,
  listSource: ListSource,
  listEntryId: z.string().nullable().optional(),
  matchScore: z.number().nullable().optional(),
  matchedFields: z.any().optional(),
  rawEntry: z.any(),
});

const EvaluationSchema = z.object({
  hitId: z.string(),
  decision: z.enum(['confirmed', 'dismissed', 'needs_review']),
  category: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high']).optional(),
  llmReasoning: z.string(),
  llmScore: z.number().optional(),
  fragmentId: z.string().optional(),
  humanOverride: z.enum(['confirmed', 'dismissed']).optional(),
  overrideReason: z.string().optional(),
});

const ScreeningReportSchema = z.object({
  summary: z.object({
    subjectCount: z.number().int(),
    confirmedHits: z.number().int(),
    needsReview: z.number().int(),
    dismissedHits: z.number().int(),
    overallRisk: z.enum(['low', 'medium', 'high']),
  }),
  perSubject: z.array(z.any()).default(() => []),
  byList: z.record(z.string(), z.any()).default(() => ({})),
});

// ---------------------------------------------------------------------------
// Risk assessment (Phase 3) — single-writer (the assess_risk node), no reducer.
// ---------------------------------------------------------------------------

const RiskFactorSchema = z.object({
  factor: z.string(),
  label: z.string().optional(),
  weight: z.number(),
  baseScore: z.number(),
  contribution: z.number(),
  attribute: z.any().optional(),
  evidence: z.any().optional(),
});

const RiskTier = z.enum(['Low', 'Medium', 'High']);
const RiskOutcome = z.enum(['Low', 'Medium', 'High', 'Prohibited']);

const RiskAssessmentSchema = z.object({
  score: z.number(),
  tier: RiskTier,
  outcome: RiskOutcome,
  factors: z.array(RiskFactorSchema).default(() => []),
  knockoutsTriggered: z.array(z.string()).default(() => []),
  deltaFromPrevious: z.number().nullable().optional(),
  deltaFlagged: z.boolean().default(false),
  matrixVersionId: z.string().nullable().optional(),
  matrixVersion: z.number().nullable().optional(),
  calculatedAt: z.string(),
  rationale: z.string().optional(),
  receipt: z.any().optional(),
});

// ---------------------------------------------------------------------------
// QA result (Phase 5) — single-writer (the qa_check node), no reducer.
// Same shape pattern as riskAssessment.
// ---------------------------------------------------------------------------

const QaCaseStatus = z.enum(['auto_approved', 'streamlined_review', 'standard_review']);
const QaSeverity = z.enum(['low', 'medium', 'high']);

const QaHighlightedIssueSchema = z.object({
  code: z.string(),
  severity: QaSeverity,
  message: z.string(),
  anchor: z.string(),
  evidence: z.any().optional(),
});

const QaConsistencyIssueSchema = z.object({
  code: z.string(),
  message: z.string(),
  evidence: z.any().optional(),
});

const QaNarrativeSchema = z.object({
  text: z.string(),
  paragraphCount: z.number().int(),
  tier: z.string(),
  model: z.string().optional(),
  promptVersionId: z.string().nullable().optional(),
  generatedAt: z.string(),
});

const QaResultSchema = z.object({
  passed: z.boolean(),
  // Phase 2 (v0.1) — degraded-mode markers. `skipped` is true when the QA
  // agent itself was disabled (the qa_skipped stamp node wrote this result);
  // `skippedAgents` lists upstream agents that were disabled for this run and
  // influenced routing (skipped screening/risk force standard_review — fail
  // toward human review, never auto-approve on partial assessment).
  skipped: z.boolean().optional(),
  skippedAgents: z.array(z.string()).optional(),
  completeness: z.object({
    passed: z.boolean(),
    missing: z.array(z.string()).default(() => []),
    warnings: z.array(z.string()).default(() => []),
  }),
  consistency: z.object({
    passed: z.boolean(),
    issues: z.array(QaConsistencyIssueSchema).default(() => []),
  }),
  routing: z.object({
    caseStatus: QaCaseStatus,
    qaSummary: z.string(),
  }),
  highlightedIssues: z.array(QaHighlightedIssueSchema).default(() => []),
  qaSummary: z.string(),
  tier: z.string().nullable().optional(),
  evaluatedAt: z.string(),
});

const concatReducer = (a, b) => {
  const left = Array.isArray(a) ? a : [];
  if (b == null) return left;
  return left.concat(b);
};

const stateSchema = z.object({
  input: withLangGraph(InputSchema, {
    default: () => ({}),
  }),
  candidates: withLangGraph(z.array(CandidateSchema), {
    default: () => [],
  }),
  resolution: ResolutionSchema.optional(),
  companyNumber: z.string().optional(),

  // R4a — run identity as first-class channels. Single-writer, no reducer.
  // Populated write-through by the first node that resolves them via
  // ensureRunIdentity (graph/nodes/_identity.js); absent until the SSE
  // runtime's lazy dossier+run upsert has happened (post gather_input).
  dossierId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),

  profile: z.any().optional(),
  officers: z.any().optional(),
  psc: z.any().optional(),
  filingHistory: z.any().optional(),

  documents: withLangGraph(z.array(DocumentSchema), {
    default: () => [],
  }),
  kycCard: KycCardSchema.optional(),
  shareholderGraph: ShareholderGraphSchema.optional(),

  trace: withLangGraph(z.array(TraceEventSchema), {
    reducer: { fn: concatReducer },
    default: () => [],
  }),
  errors: withLangGraph(z.array(ErrorEventSchema), {
    reducer: { fn: concatReducer },
    default: () => [],
  }),
  fragments: withLangGraph(z.array(DecisionFragmentSchema), {
    reducer: { fn: concatReducer },
    default: () => [],
  }),

  parties: withLangGraph(z.array(StatePartySchema), {
    default: () => [],
  }),
  partyLinks: withLangGraph(z.array(StatePartyLinkSchema), {
    default: () => [],
  }),

  screeningSubjects: withLangGraph(z.array(SubjectSchema), {
    default: () => [],
  }),
  screeningHits: withLangGraph(z.array(HitSchema), {
    reducer: { fn: concatReducer },
    default: () => [],
  }),
  screeningEvaluations: withLangGraph(z.array(EvaluationSchema), {
    reducer: { fn: concatReducer },
    default: () => [],
  }),
  screeningReport: ScreeningReportSchema.optional(),

  riskAssessment: RiskAssessmentSchema.optional(),
  qaResult: QaResultSchema.optional(),
  qaNarrative: QaNarrativeSchema.optional(),

  // Phase 2 (v0.1) — per-run snapshot of which agents were disabled when the
  // run was dispatched ({ agentId: 'skipped' }). Seeded once by
  // runDispatch#executeRunJob; consumers (QA engine, risk receipt) treat a
  // skipped agent's missing output as "not evaluated", never as a failure.
  // Frozen per run: toggling an agent mid-run does not change this snapshot.
  agentStatus: withLangGraph(z.record(z.string(), z.enum(['skipped', 'completed', 'failed'])), {
    default: () => ({}),
  }),
});

function traceEvent(node, msg, extra) {
  const evt = { node, ts: Date.now(), msg };
  if (extra) evt.extra = extra;
  return evt;
}

function errorEvent(node, message) {
  return { node, message, ts: Date.now() };
}

module.exports = {
  stateSchema,
  traceEvent,
  errorEvent,
  DecisionFragmentSchema,
  SubjectSchema,
  HitSchema,
  EvaluationSchema,
  ScreeningReportSchema,
  RiskFactorSchema,
  RiskAssessmentSchema,
  QaResultSchema,
  QaNarrativeSchema,
};
