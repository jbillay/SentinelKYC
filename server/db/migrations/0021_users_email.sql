-- R1 follow-up — add an email field to users for the self-service profile page.
--
-- Nullable (existing seeded users have none) and uniquely indexed when present
-- (case-insensitive), so two accounts can't share an email but many can have
-- none. Edited via PATCH /api/auth/profile.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_idx"
  ON "users" (lower("email"))
  WHERE "email" IS NOT NULL;
