CREATE TABLE IF NOT EXISTS "screening_config" (
  "id" integer PRIMARY KEY DEFAULT 1,
  "match_threshold" numeric(4,3) NOT NULL DEFAULT 0.85,
  "bing_results_per_subject" integer NOT NULL DEFAULT 20,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "screening_config_singleton" CHECK ("id" = 1)
);

INSERT INTO "screening_config" ("id", "match_threshold", "bing_results_per_subject")
VALUES (1, 0.85, 20)
ON CONFLICT ("id") DO NOTHING;
