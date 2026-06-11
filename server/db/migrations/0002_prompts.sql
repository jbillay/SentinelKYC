CREATE TABLE IF NOT EXISTS "prompt_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "prompt_key" text NOT NULL,
  "version" integer NOT NULL,
  "body" text NOT NULL,
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "prompt_versions_key_version_unique" UNIQUE ("prompt_key", "version")
);

CREATE INDEX IF NOT EXISTS "prompt_versions_key_idx" ON "prompt_versions" ("prompt_key");

CREATE TABLE IF NOT EXISTS "prompt_active" (
  "prompt_key" text PRIMARY KEY,
  "version_id" uuid NOT NULL REFERENCES "prompt_versions" ("id") ON DELETE RESTRICT,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
