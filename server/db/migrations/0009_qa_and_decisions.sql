-- Phase 5 / Q1 — QA agent + final-decision data foundation.
-- Adds:
--   * 'human_action' value on the existing fragment_kind enum (for the
--     immutable audit fragments written by POST .../runs/:runId/decision).
--   * case_status enum + dossiers.case_status* triplet (latest-run-wins
--     case lifecycle: pending → … → approved/rejected/escalated).
--   * runs.qa_result jsonb — per-run frozen QA snapshot, nullable so
--     pre-Phase-5 runs render "not yet QA-checked".

ALTER TYPE "public"."fragment_kind" ADD VALUE IF NOT EXISTS 'human_action';--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'case_status') THEN
    CREATE TYPE "public"."case_status" AS ENUM (
      'pending',
      'auto_approved',
      'streamlined_review',
      'standard_review',
      'info_requested',
      'approved',
      'rejected',
      'escalated'
    );
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "dossiers"
  ADD COLUMN IF NOT EXISTS "case_status" "public"."case_status" NOT NULL DEFAULT 'pending';--> statement-breakpoint

ALTER TABLE "dossiers"
  ADD COLUMN IF NOT EXISTS "case_status_updated_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "dossiers"
  ADD COLUMN IF NOT EXISTS "case_status_run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "qa_result" jsonb;--> statement-breakpoint

-- Phase 5 also adds a qaThresholds block to the risk matrix. Backfill any
-- pre-existing matrix versions that don't carry it so validateMatrix continues
-- to accept the seeded v1 without manual intervention.
UPDATE "risk_matrix_versions"
SET "body" = "body" || jsonb_build_object(
  'qaThresholds',
  jsonb_build_object('autoApproveMax', 25, 'sanctionHitMinScore', 90)
)
WHERE NOT ("body" ? 'qaThresholds');
