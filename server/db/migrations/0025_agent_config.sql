-- Phase 1 (v0.1) — versioned agent configuration + config-change audit.
--
-- Generalizes the prompt-registry pattern (0002) / risk-matrix pattern (0008):
-- append-only versions, singleton-active pointer per agent. The body is the
-- agent's full config object (validated server-side against the manifest's
-- Zod schema in agents/registry.js); fields flagged secret in the manifest
-- are stored AES-256-GCM-encrypted inside the jsonb (enc:v1:... strings).

CREATE TABLE IF NOT EXISTS "agent_config_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" text NOT NULL,
  "version" integer NOT NULL,
  "body" jsonb NOT NULL,
  "notes" text,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_config_versions_agent_version_unique" UNIQUE ("agent_id", "version")
);

CREATE INDEX IF NOT EXISTS "agent_config_versions_agent_idx"
  ON "agent_config_versions" ("agent_id");

CREATE TABLE IF NOT EXISTS "agent_config_active" (
  "agent_id" text PRIMARY KEY,
  "version_id" uuid NOT NULL REFERENCES "agent_config_versions" ("id") ON DELETE RESTRICT,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Immutable audit trail for configuration changes (who changed what, when).
-- Scope is a free string ('agent:screening') so prompt / matrix / screening
-- config changes can adopt the same table later without a schema change.
CREATE TABLE IF NOT EXISTS "config_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope" text NOT NULL,
  "action" text NOT NULL,
  "version_id" uuid,
  "actor" text,
  "details" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "config_audit_scope_idx"
  ON "config_audit" ("scope", "created_at" DESC);
