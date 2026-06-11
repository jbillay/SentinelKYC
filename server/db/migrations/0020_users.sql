-- R1 — Application-owned user store for authentication + role-based access.
--
-- Replaces the spoofable `x-user-id` header model. Identity is now carried in a
-- server-side session (express-session + connect-pg-simple, whose `session`
-- table is created by the library at boot via createTableIfMissing) and every
-- audited actor (decision_fragments.inputs.userId, party_match_log.called_by,
-- watchlist.added_by, …) is derived from a verified session user.
--
-- Roles are a hardcoded enum for now (no role-management UI):
--   analyst  — run + read, recommend only; cannot make a final decision
--   reviewer — analyst + make final decisions / approvals
--   admin    — reviewer + edit prompts / risk matrix / screening config
--
-- Seeded by server/scripts/seed-users.js from .env passwords (no credentials in
-- source). Written by: POST /api/auth/login (last_login_at), seed script.
-- Read by: the auth middleware (session → user lookup) + GET /api/auth/me.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
    CREATE TYPE "public"."user_role" AS ENUM ('analyst', 'reviewer', 'admin');
  END IF;
END$$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "display_name" text,
  "password_hash" text NOT NULL,
  "role" "user_role" NOT NULL DEFAULT 'analyst',
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_login_at" timestamptz,
  CONSTRAINT "users_username_unique" UNIQUE ("username")
);--> statement-breakpoint

-- Case-insensitive username lookup support (login normalises to lower-case, but
-- guard against a future case-sensitive path inserting a dup).
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_lower_idx"
  ON "users" (lower("username"));
