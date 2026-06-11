-- Risk matrix tables (versioned + singleton-active, mirroring prompt registry)
-- and the runs.final_risk_assessment column populated by the assess_risk node.

CREATE TABLE IF NOT EXISTS "risk_matrix_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "version" integer NOT NULL UNIQUE,
  "body" jsonb NOT NULL,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "risk_matrix_active" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "version_id" uuid NOT NULL REFERENCES "risk_matrix_versions"("id") ON DELETE RESTRICT,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "risk_matrix_active_singleton" CHECK ("id" = 1)
);

ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "final_risk_assessment" jsonb;
