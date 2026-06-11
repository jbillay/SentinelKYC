const {
  pgTable,
  pgEnum,
  uuid,
  text,
  timestamp,
  integer,
  bigserial,
  jsonb,
  numeric,
  unique,
  boolean,
  date,
} = require('drizzle-orm/pg-core');
const { sql, relations } = require('drizzle-orm');

// Forward-reference helper for self/circular FKs (case_status_run_id and
// parent_fragment_id below). At the point those columns are declared, the
// target table is not yet fully constructed, so we wrap the reference in an
// arrow function so Drizzle resolves it lazily.
// See https://orm.drizzle.team/docs/relations#foreign-keys

const runStatus = pgEnum('run_status', ['running', 'done', 'failed', 'not_found', 'cancelled']);
const runTrigger = pgEnum('run_trigger', ['initial', 'refresh', 'rescreen']);
const fragmentKind = pgEnum('fragment_kind', ['decision', 'audit', 'human_action']);
const fragmentStatus = pgEnum('fragment_status', ['ok', 'failed', 'skipped']);
const caseStatus = pgEnum('case_status', [
  'pending',
  'auto_approved',
  'streamlined_review',
  'standard_review',
  'info_requested',
  'approved',
  'rejected',
  'escalated',
]);

const dossiers = pgTable('dossiers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyNumber: text('company_number').notNull().unique(),
  companyName: text('company_name'),
  tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  caseStatus: caseStatus('case_status').notNull().default('pending'),
  caseStatusUpdatedAt: timestamp('case_status_updated_at', { withTimezone: true }),
  // FK is declared at the column level in migration 0009 (ON DELETE SET NULL)
  // and re-declared here so drizzle-kit introspect / typed queries see it.
  caseStatusRunId: uuid('case_status_run_id').references(() => runs.id, {
    onDelete: 'set null',
  }),
});

const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  dossierId: uuid('dossier_id')
    .notNull()
    .references(() => dossiers.id, { onDelete: 'cascade' }),
  threadId: text('thread_id').notNull().unique(),
  status: runStatus('status').notNull().default('running'),
  trigger: runTrigger('trigger').notNull().default('initial'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  finalKycCard: jsonb('final_kyc_card'),
  finalShareholderGraph: jsonb('final_shareholder_graph'),
  finalDocuments: jsonb('final_documents'),
  finalScreeningReport: jsonb('final_screening_report'),
  finalProfile: jsonb('final_profile'),
  finalOfficers: jsonb('final_officers'),
  finalPsc: jsonb('final_psc'),
  finalRiskAssessment: jsonb('final_risk_assessment'),
  qaResult: jsonb('qa_result'),
  qaNarrative: jsonb('qa_narrative'),
  error: text('error'),
  // R2: which worker process is driving this run (null for inline-mode runs).
  workerId: text('worker_id'),
  // R4b: set inside the applyDecision txn when a graph resume is owed (the
  // /decision route path); cleared on durable dispatch and at any terminus.
  // Non-null + status='running' ⇒ the boot reconciler owes this run a resume.
  resumeOwedAt: timestamp('resume_owed_at', { withTimezone: true }),
});

// R2 — durable, replayable SSE event channel that crosses the worker↔web
// process boundary. One row per emitted SSE event, ordered per thread by `seq`.
// See db/migrations/0022_run_events.sql.
const runEvents = pgTable('run_events', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  threadId: text('thread_id').notNull(),
  seq: integer('seq').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const decisionFragments = pgTable('decision_fragments', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  // Self-reference. Migration 0003 created this as ON DELETE CASCADE; migration
  // 0010 changes it to ON DELETE SET NULL so deleting an `evaluate_*` parent
  // fragment never silently drops the per-hit child audit subtree.
  parentFragmentId: uuid('parent_fragment_id').references(
    () => decisionFragments.id,
    { onDelete: 'set null' },
  ),
  nodeId: text('node_id').notNull(),
  sequence: integer('sequence').notNull(),
  kind: fragmentKind('kind').notNull(),
  status: fragmentStatus('status').notNull().default('ok'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  durationMs: integer('duration_ms'),
  summary: text('summary'),
  inputs: jsonb('inputs'),
  outputs: jsonb('outputs'),
  error: text('error'),
});

const dossiersRelations = relations(dossiers, ({ one, many }) => ({
  runs: many(runs),
  screeningOverrides: many(dossierScreeningOverrides),
  caseStatusRun: one(runs, {
    fields: [dossiers.caseStatusRunId],
    references: [runs.id],
    relationName: 'dossierCaseStatusRun',
  }),
}));

const runsRelations = relations(runs, ({ one, many }) => ({
  dossier: one(dossiers, { fields: [runs.dossierId], references: [dossiers.id] }),
  fragments: many(decisionFragments),
  screeningHits: many(screeningHits),
}));

const decisionFragmentsRelations = relations(decisionFragments, ({ one, many }) => ({
  run: one(runs, { fields: [decisionFragments.runId], references: [runs.id] }),
  parent: one(decisionFragments, {
    fields: [decisionFragments.parentFragmentId],
    references: [decisionFragments.id],
    relationName: 'fragmentParent',
  }),
  children: many(decisionFragments, { relationName: 'fragmentParent' }),
}));

const promptVersions = pgTable('prompt_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  promptKey: text('prompt_key').notNull(),
  version: integer('version').notNull(),
  body: text('body').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const promptActive = pgTable('prompt_active', {
  promptKey: text('prompt_key').primaryKey(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => promptVersions.id, { onDelete: 'restrict' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const promptActiveRelations = relations(promptActive, ({ one }) => ({
  version: one(promptVersions, {
    fields: [promptActive.versionId],
    references: [promptVersions.id],
  }),
}));

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

const sanctionsLists = pgTable(
  'sanctions_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    version: text('version').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    recordCount: integer('record_count').notNull().default(0),
  },
  (t) => ({
    sourceVersionUnique: unique('sanctions_lists_source_version_unique').on(t.source, t.version),
  }),
);

const sanctionsEntries = pgTable(
  'sanctions_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listSource: text('list_source').notNull(),
    listEntryId: text('list_entry_id').notNull(),
    entryType: text('entry_type').notNull(),
    primaryName: text('primary_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    aliases: jsonb('aliases').notNull().default(sql`'[]'::jsonb`),
    dob: text('dob'),
    nationality: text('nationality').array(),
    identifiers: jsonb('identifiers'),
    programs: text('programs').array(),
    raw: jsonb('raw').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sourceEntryUnique: unique('sanctions_entries_source_entry_unique').on(t.listSource, t.listEntryId),
  }),
);

const screeningHits = pgTable('screening_hits', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  // Phase 2: link to party master. Nullable for forward-compatibility with
  // pre-Phase-2 hits and to support the edge case where the screening list
  // produced a hit before the resolver populated state.parties (shouldn't
  // happen post-Phase-2 but we keep the data model permissive).
  partyId: uuid('party_id'),
  subjectId: text('subject_id').notNull(),
  subjectName: text('subject_name').notNull(),
  subjectKind: text('subject_kind').notNull(),
  subjectSource: text('subject_source').notNull(),
  listSource: text('list_source').notNull(),
  listEntryId: text('list_entry_id'),
  matchScore: numeric('match_score', { precision: 4, scale: 3 }),
  matchedFields: jsonb('matched_fields'),
  rawEntry: jsonb('raw_entry').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const screeningEvaluations = pgTable(
  'screening_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hitId: uuid('hit_id')
      .notNull()
      .references(() => screeningHits.id, { onDelete: 'cascade' }),
    decision: text('decision').notNull(),
    category: text('category'),
    severity: text('severity'),
    llmReasoning: text('llm_reasoning').notNull(),
    llmScore: numeric('llm_score', { precision: 4, scale: 3 }),
    fragmentId: uuid('fragment_id'),
    humanOverride: text('human_override'),
    overrideReason: text('override_reason'),
    overrideAt: timestamp('override_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    hitUnique: unique('screening_evaluations_hit_unique').on(t.hitId),
  }),
);

const dossierScreeningOverrides = pgTable(
  'dossier_screening_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dossierId: uuid('dossier_id')
      .notNull()
      .references(() => dossiers.id, { onDelete: 'cascade' }),
    subjectId: text('subject_id').notNull(),
    listSource: text('list_source').notNull(),
    listEntryId: text('list_entry_id'),
    evidenceUrl: text('evidence_url'),
    decision: text('decision').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    overrideUnique: unique('dossier_screening_overrides_unique').on(
      t.dossierId,
      t.subjectId,
      t.listSource,
      t.listEntryId,
      t.evidenceUrl,
    ),
  }),
);

const screeningConfig = pgTable('screening_config', {
  id: integer('id').primaryKey().default(1),
  matchThreshold: numeric('match_threshold', { precision: 4, scale: 3 }).notNull().default('0.85'),
  bingResultsPerSubject: integer('bing_results_per_subject').notNull().default(20),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const screeningHitsRelations = relations(screeningHits, ({ one }) => ({
  run: one(runs, { fields: [screeningHits.runId], references: [runs.id] }),
  evaluation: one(screeningEvaluations, {
    fields: [screeningHits.id],
    references: [screeningEvaluations.hitId],
  }),
}));

const screeningEvaluationsRelations = relations(screeningEvaluations, ({ one }) => ({
  hit: one(screeningHits, {
    fields: [screeningEvaluations.hitId],
    references: [screeningHits.id],
  }),
}));

const dossierScreeningOverridesRelations = relations(dossierScreeningOverrides, ({ one }) => ({
  dossier: one(dossiers, {
    fields: [dossierScreeningOverrides.dossierId],
    references: [dossiers.id],
  }),
}));

// ---------------------------------------------------------------------------
// Risk matrix
// ---------------------------------------------------------------------------

const riskMatrixVersions = pgTable('risk_matrix_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  version: integer('version').notNull().unique(),
  body: jsonb('body').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const riskMatrixActive = pgTable('risk_matrix_active', {
  id: integer('id').primaryKey().default(1),
  versionId: uuid('version_id')
    .notNull()
    .references(() => riskMatrixVersions.id, { onDelete: 'restrict' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

const riskMatrixActiveRelations = relations(riskMatrixActive, ({ one }) => ({
  version: one(riskMatrixVersions, {
    fields: [riskMatrixActive.versionId],
    references: [riskMatrixVersions.id],
  }),
}));

// ---------------------------------------------------------------------------
// Party Master (Phase 1a — name matcher only).
//
// The table is created with its full shape in migration 0012, but only
// id / full_name / name_canonical are exercised by the matcher today. The
// dormant columns (structured identity, strong-key identifiers, dossier_id
// back-link, dedup state, soft-merge pointer) will be populated by the
// in-graph resolve_parties node in Phase 1b.
//
// `name_canonical` is GENERATED ALWAYS AS (name_canonical(full_name)) STORED
// at the DB level — never assign it directly from JS.
//
// `party_type` is a plain text column with a CHECK constraint in SQL (see
// the migration) — we intentionally avoid a pgenum so future values like
// 'trust' or 'partnership' don't require an ALTER TYPE migration.
// ---------------------------------------------------------------------------

const parties = pgTable('parties', {
  id: uuid('id').primaryKey().defaultRandom(),
  partyType: text('party_type').notNull(),

  fullName: text('full_name').notNull(),
  // DB-generated; included here so drizzle-kit introspect sees it. Treated
  // as read-only — every write path uses fullName and lets Postgres compute
  // the canonical form.
  nameCanonical: text('name_canonical'),

  forename: text('forename'),
  middleNames: text('middle_names'),
  surname: text('surname'),
  title: text('title'),
  dateOfBirthYear: integer('date_of_birth_year'),
  dateOfBirthMonth: integer('date_of_birth_month'),
  nationality: text('nationality').array(),
  countryOfResidence: text('country_of_residence'),

  registrationNumber: text('registration_number'),
  registrationCountry: text('registration_country'),
  // Soft FK to dossiers (set when the org is a CH-known dossier of ours).
  // ON DELETE SET NULL in the migration so dossier deletion doesn't cascade
  // into the party master.
  dossierId: uuid('dossier_id').references(() => dossiers.id, {
    onDelete: 'set null',
  }),

  chOfficerAppointmentId: text('ch_officer_appointment_id'),

  aliases: jsonb('aliases').notNull().default(sql`'[]'::jsonb`),
  identifiers: jsonb('identifiers').notNull().default(sql`'{}'::jsonb`),

  sourceKind: text('source_kind').notNull().default('manual'),
  needsReview: boolean('needs_review').notNull().default(false),
  reviewReason: text('review_reason'),
  // Self-FK; the actual FK is added in the migration via ALTER TABLE so the
  // forward reference works. Drizzle just needs the column shape.
  mergedIntoPartyId: uuid('merged_into_party_id'),
  // Phase 4 merge-audit columns. Populated together when a reviewer merges
  // this party into another.
  mergedBy: text('merged_by'),
  mergedAt: timestamp('merged_at', { withTimezone: true }),
  mergeReason: text('merge_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Per-call audit log for the matcher. Written on every findMatches invocation
// — including zero-match calls — by both the HTTP route and (in Phase 1b)
// the in-graph resolve_parties node. Required for KYC audit replay.
//
// `source` ∈ {'api', 'resolver'}. The corresponding graph-step audit is one
// summary row in decision_fragments per resolve_parties invocation — these
// two audit grains are deliberately separate (see auditLog.js).
const partyMatchLog = pgTable('party_match_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  inputName: text('input_name').notNull(),
  inputCanonical: text('input_canonical').notNull(),
  candidates: jsonb('candidates').notNull(),
  matchCount: integer('match_count').notNull().default(0),
  topScore: numeric('top_score', { precision: 4, scale: 3 }),
  calledBy: text('called_by').notNull(),
  source: text('source').notNull().default('api'),
  calledAt: timestamp('called_at', { withTimezone: true }).notNull().defaultNow(),
});

const partiesRelations = relations(parties, ({ one, many }) => ({
  dossier: one(dossiers, {
    fields: [parties.dossierId],
    references: [dossiers.id],
  }),
  // Self-relation for the soft-merge pointer. Drizzle requires a name to
  // disambiguate when both sides are the same table.
  mergedInto: one(parties, {
    fields: [parties.mergedIntoPartyId],
    references: [parties.id],
    relationName: 'partyMergedInto',
  }),
  links: many(partyLinks),
}));

// ---------------------------------------------------------------------------
// Party Master linkage (Phase 1b — resolver writes here).
//
// Constraint mirrors party_links_uniq in migration 0014: a re-run of the
// resolver must hit the same logical link (party + dossier + role + dates)
// and upsert in place. CHECK constraints on `role` and `status` enforced at
// the DB level.
// ---------------------------------------------------------------------------

const partyLinks = pgTable('party_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  partyId: uuid('party_id')
    .notNull()
    .references(() => parties.id, { onDelete: 'cascade' }),
  dossierId: uuid('dossier_id')
    .notNull()
    .references(() => dossiers.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  roleDetail: text('role_detail'),
  status: text('status').notNull(),
  naturesOfControl: text('natures_of_control').array(),
  sharesCount: numeric('shares_count'),
  sharesPercentage: numeric('shares_percentage', { precision: 5, scale: 2 }),
  shareClass: text('share_class'),
  appointedOn: date('appointed_on'),
  resignedOn: date('resigned_on'),
  notifiedOn: date('notified_on'),
  ceasedOn: date('ceased_on'),
  sourceRef: jsonb('source_ref'),
  firstSeenRunId: uuid('first_seen_run_id').references(() => runs.id, { onDelete: 'set null' }),
  lastSeenRunId: uuid('last_seen_run_id').references(() => runs.id, { onDelete: 'set null' }),
  matchConfidence: numeric('match_confidence', { precision: 4, scale: 3 }),
  matchEvidence: jsonb('match_evidence'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Append-only transition log. One row per status change. Mirrors the
// decision_fragments immutability discipline — never updated after insert.
const partyLinkStatusHistory = pgTable('party_link_status_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  linkId: uuid('link_id')
    .notNull()
    .references(() => partyLinks.id, { onDelete: 'cascade' }),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
  reason: text('reason'),
});

// Pending dedup decisions. status ∈ {'open','merged','rejected'} with a
// partial-unique index on (party_id, candidate_party_id) WHERE status='open'
// so re-runs upsert into the existing open row.
const partyReviewQueue = pgTable('party_review_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  partyId: uuid('party_id')
    .notNull()
    .references(() => parties.id, { onDelete: 'cascade' }),
  candidatePartyId: uuid('candidate_party_id')
    .notNull()
    .references(() => parties.id, { onDelete: 'cascade' }),
  score: numeric('score', { precision: 4, scale: 3 }).notNull(),
  confidence: text('confidence').notNull(),
  matchedVia: text('matched_via').notNull(),
  evidence: jsonb('evidence').notNull().default(sql`'{}'::jsonb`),
  status: text('status').notNull().default('open'),
  raisedByRunId: uuid('raised_by_run_id').references(() => runs.id, { onDelete: 'set null' }),
  resolvedBy: text('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionReason: text('resolution_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

const partyLinksRelations = relations(partyLinks, ({ one, many }) => ({
  party: one(parties, { fields: [partyLinks.partyId], references: [parties.id] }),
  dossier: one(dossiers, { fields: [partyLinks.dossierId], references: [dossiers.id] }),
  statusHistory: many(partyLinkStatusHistory),
}));

const partyLinkStatusHistoryRelations = relations(partyLinkStatusHistory, ({ one }) => ({
  link: one(partyLinks, {
    fields: [partyLinkStatusHistory.linkId],
    references: [partyLinks.id],
  }),
}));

const partyReviewQueueRelations = relations(partyReviewQueue, ({ one }) => ({
  // Both sides of the candidate pair point at parties; disambiguate the
  // relation names so drizzle queries can navigate either direction.
  party: one(parties, {
    fields: [partyReviewQueue.partyId],
    references: [parties.id],
    relationName: 'reviewQueueParty',
  }),
  candidate: one(parties, {
    fields: [partyReviewQueue.candidatePartyId],
    references: [parties.id],
    relationName: 'reviewQueueCandidate',
  }),
}));

// ---------------------------------------------------------------------------
// Phase 3 — Party-level screening overrides (cross-dossier).
//
// The dossier-level dossier_screening_overrides table stays in place for
// pre-Phase-2 hits (no party_id). New runs whose hits carry a party_id
// match against this table FIRST and only fall through to the dossier-level
// table for legacy data.
// ---------------------------------------------------------------------------

const partyScreeningOverrides = pgTable(
  'party_screening_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    listSource: text('list_source').notNull(),
    listEntryId: text('list_entry_id'),
    evidenceUrl: text('evidence_url'),
    decision: text('decision').notNull(),
    reason: text('reason'),
    appliedBy: text('applied_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    partyOverrideUnique: unique('party_screening_overrides_unique').on(
      t.partyId,
      t.listSource,
      t.listEntryId,
      t.evidenceUrl,
    ),
  }),
);

const partyScreeningOverridesRelations = relations(partyScreeningOverrides, ({ one }) => ({
  party: one(parties, {
    fields: [partyScreeningOverrides.partyId],
    references: [parties.id],
  }),
}));

// ---------------------------------------------------------------------------
// Party watchlist — reviewer-flagged parties tracked across dossiers.
//
// One row per watched party (party_id unique). Carries who flagged it and
// why so the watchlist view + audit can explain the entry. Deliberately
// minimal: membership is the whole feature for the POC — no alerting,
// no re-screen scheduling (out of scope, see CLAUDE.md POC guards).
// ---------------------------------------------------------------------------
const partyWatchlist = pgTable(
  'party_watchlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partyId: uuid('party_id')
      .notNull()
      .references(() => parties.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    addedBy: text('added_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    partyWatchlistUnique: unique('party_watchlist_party_unique').on(t.partyId),
  }),
);

const partyWatchlistRelations = relations(partyWatchlist, ({ one }) => ({
  party: one(parties, {
    fields: [partyWatchlist.partyId],
    references: [parties.id],
  }),
}));

// ---------------------------------------------------------------------------
// R1 — Users / authentication. Application-owned user store; identity is
// carried in a server-side session and feeds every audited actor. Roles are a
// hardcoded enum (no role-management UI yet). See migration 0020 + services/auth.
// ---------------------------------------------------------------------------

const userRole = pgEnum('user_role', ['analyst', 'reviewer', 'admin']);

const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  email: text('email'),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('analyst'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
});

module.exports = {
  userRole,
  users,
  runStatus,
  runTrigger,
  fragmentKind,
  fragmentStatus,
  caseStatus,
  dossiers,
  runs,
  runEvents,
  decisionFragments,
  dossiersRelations,
  runsRelations,
  decisionFragmentsRelations,
  promptVersions,
  promptActive,
  promptActiveRelations,
  sanctionsLists,
  sanctionsEntries,
  screeningHits,
  screeningEvaluations,
  dossierScreeningOverrides,
  screeningConfig,
  screeningHitsRelations,
  screeningEvaluationsRelations,
  dossierScreeningOverridesRelations,
  riskMatrixVersions,
  riskMatrixActive,
  riskMatrixActiveRelations,
  parties,
  partyMatchLog,
  partiesRelations,
  partyLinks,
  partyLinkStatusHistory,
  partyReviewQueue,
  partyLinksRelations,
  partyLinkStatusHistoryRelations,
  partyReviewQueueRelations,
  partyScreeningOverrides,
  partyScreeningOverridesRelations,
  partyWatchlist,
  partyWatchlistRelations,
};
