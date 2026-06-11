-- Sanctions list cache
CREATE TABLE IF NOT EXISTS "sanctions_lists" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source" text NOT NULL,
  "version" text NOT NULL,
  "fetched_at" timestamptz NOT NULL DEFAULT now(),
  "record_count" integer NOT NULL DEFAULT 0,
  CONSTRAINT "sanctions_lists_source_version_unique" UNIQUE ("source", "version")
);

CREATE TABLE IF NOT EXISTS "sanctions_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "list_source" text NOT NULL,
  "list_entry_id" text NOT NULL,
  "entry_type" text NOT NULL,
  "primary_name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "aliases" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "dob" text,
  "nationality" text[],
  "identifiers" jsonb,
  "programs" text[],
  "raw" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sanctions_entries_source_entry_unique" UNIQUE ("list_source", "list_entry_id")
);

CREATE INDEX IF NOT EXISTS "sanctions_entries_list_source_idx" ON "sanctions_entries" ("list_source");
CREATE INDEX IF NOT EXISTS "sanctions_entries_normalized_name_idx" ON "sanctions_entries" ("normalized_name");
CREATE INDEX IF NOT EXISTS "sanctions_entries_aliases_gin" ON "sanctions_entries" USING gin ("aliases" jsonb_path_ops);

-- Per-run hits (one row per subject x list x match)
CREATE TABLE IF NOT EXISTS "screening_hits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "run_id" uuid NOT NULL REFERENCES "runs" ("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "subject_name" text NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_source" text NOT NULL,
  "list_source" text NOT NULL,
  "list_entry_id" text,
  "match_score" numeric(4,3),
  "matched_fields" jsonb,
  "raw_entry" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "screening_hits_run_idx" ON "screening_hits" ("run_id");
CREATE INDEX IF NOT EXISTS "screening_hits_run_subject_idx" ON "screening_hits" ("run_id", "subject_id");

-- Per-hit LLM evaluation (+ optional human override)
CREATE TABLE IF NOT EXISTS "screening_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "hit_id" uuid NOT NULL REFERENCES "screening_hits" ("id") ON DELETE CASCADE,
  "decision" text NOT NULL,
  "category" text,
  "llm_reasoning" text NOT NULL,
  "llm_score" numeric(4,3),
  "fragment_id" uuid,
  "human_override" text,
  "override_reason" text,
  "override_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "screening_evaluations_hit_unique" UNIQUE ("hit_id")
);

CREATE INDEX IF NOT EXISTS "screening_evaluations_hit_idx" ON "screening_evaluations" ("hit_id");

-- Dossier-level overrides that auto-apply on subsequent runs
CREATE TABLE IF NOT EXISTS "dossier_screening_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "dossier_id" uuid NOT NULL REFERENCES "dossiers" ("id") ON DELETE CASCADE,
  "subject_id" text NOT NULL,
  "list_source" text NOT NULL,
  "list_entry_id" text,
  "evidence_url" text,
  "decision" text NOT NULL,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dossier_screening_overrides_unique" UNIQUE ("dossier_id", "subject_id", "list_source", "list_entry_id", "evidence_url")
);

-- Nested decision fragments: one parent per evaluate_* node, one child per hit
ALTER TABLE "decision_fragments"
  ADD COLUMN IF NOT EXISTS "parent_fragment_id" uuid REFERENCES "decision_fragments" ("id") ON DELETE CASCADE;

-- Frozen screening report so RunDetailPage doesn't need to re-derive from hits
ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "final_screening_report" jsonb;
