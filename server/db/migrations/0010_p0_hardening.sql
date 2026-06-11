-- P0 hardening from CODE_REVIEW.md §3.3, §3.6, §3.12, §3.13, §3.14, §4.4, §6.5 M-7.
--
-- Idempotent: every block guards on existence so re-running is safe. Any block
-- that could fail on dirty data (existing duplicates) is wrapped in a DO block
-- that logs a NOTICE and skips the constraint instead of aborting the
-- migration, so a single-user POC with messy historical data still applies.

-- ----------------------------------------------------------------------------
-- §3.3 decision_fragments.parent_fragment_id  CASCADE → SET NULL
-- Migration 0003 created this as ON DELETE CASCADE, which silently drops the
-- per-hit audit subtree when an `evaluate_*` parent fragment is deleted.
-- Spec (CLAUDE.md "Decision fragments + SSE") says SET NULL.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  fk_name text;
BEGIN
  SELECT conname INTO fk_name
  FROM pg_constraint
  WHERE conrelid = 'decision_fragments'::regclass
    AND contype = 'f'
    AND pg_get_constraintdef(oid) LIKE '%(parent_fragment_id)%REFERENCES decision_fragments%';

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE decision_fragments DROP CONSTRAINT %I', fk_name);
  END IF;

  ALTER TABLE decision_fragments
    ADD CONSTRAINT decision_fragments_parent_fragment_id_fk
    FOREIGN KEY (parent_fragment_id)
    REFERENCES decision_fragments(id) ON DELETE SET NULL;
END $$;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- §3.6 dossier_screening_overrides_unique NULL handling
-- Postgres treats NULLs as distinct in UNIQUE by default. `list_entry_id` and
-- `evidence_url` are both nullable, so every carry-overrides-forward call
-- inserts a fresh row instead of updating when those columns are NULL.
-- NULLS NOT DISTINCT (Postgres 15+) fixes it.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  pg_major int;
BEGIN
  SELECT current_setting('server_version_num')::int / 10000 INTO pg_major;
  IF pg_major < 15 THEN
    RAISE NOTICE 'Postgres < 15 detected (%); skipping NULLS NOT DISTINCT. Upgrade and re-run.', pg_major;
  ELSE
    -- De-dupe existing duplicates first (keep the newest) so the new constraint
    -- doesn't fail on apply.
    DELETE FROM dossier_screening_overrides a
    USING dossier_screening_overrides b
    WHERE a.id < b.id
      AND a.dossier_id IS NOT DISTINCT FROM b.dossier_id
      AND a.subject_id IS NOT DISTINCT FROM b.subject_id
      AND a.list_source IS NOT DISTINCT FROM b.list_source
      AND a.list_entry_id IS NOT DISTINCT FROM b.list_entry_id
      AND a.evidence_url IS NOT DISTINCT FROM b.evidence_url;

    ALTER TABLE dossier_screening_overrides
      DROP CONSTRAINT IF EXISTS dossier_screening_overrides_unique;
    ALTER TABLE dossier_screening_overrides
      ADD CONSTRAINT dossier_screening_overrides_unique
      UNIQUE NULLS NOT DISTINCT (dossier_id, subject_id, list_source, list_entry_id, evidence_url);
  END IF;
END $$;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- §3.12 At most one running run per dossier
-- Partial unique index so concurrent /api/run for the same company are
-- rejected (the route handler catches the conflict and returns 409).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT dossier_id FROM runs WHERE status = 'running'
    GROUP BY dossier_id HAVING count(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE NOTICE 'Found % dossiers with multiple running runs; not creating runs_one_running_per_dossier. Reap stale runs first.', dup_count;
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_running_per_dossier
      ON runs (dossier_id) WHERE status = 'running';
  END IF;
END $$;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- §3.14 decision_fragments (run_id, sequence) UNIQUE
-- Guards against the sequence-allocation race in applyDecision and against
-- accidental duplicate emissions from the SSE write path.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT count(*) INTO dup_count FROM (
    SELECT run_id, sequence FROM decision_fragments
    GROUP BY run_id, sequence HAVING count(*) > 1
  ) dups;
  IF dup_count > 0 THEN
    RAISE NOTICE 'Found % duplicate (run_id, sequence) pairs; not adding decision_fragments_run_sequence_unique. Clean up first.', dup_count;
  ELSE
    BEGIN
      ALTER TABLE decision_fragments
        ADD CONSTRAINT decision_fragments_run_sequence_unique UNIQUE (run_id, sequence);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- §3.13 human_action fragment immutability
-- HTTP middleware enforces this on /api/fragments/:id, but cascade deletes
-- from parent dossiers/runs, future routes, and ad-hoc SQL all bypass it.
-- This trigger is the DB-level backstop. Cascade DELETEs from runs/dossiers
-- still fire ON DELETE on the child *before* this trigger sees the row, so
-- cascade-delete via parent removal still works (intentional: a deleted
-- dossier removes its audit trail by design).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION protect_human_action_fragments() RETURNS trigger AS $$
BEGIN
  IF OLD.kind = 'human_action' THEN
    RAISE EXCEPTION 'human_action fragments are immutable (id=%)', OLD.id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS decision_fragments_protect_update ON decision_fragments;--> statement-breakpoint
CREATE TRIGGER decision_fragments_protect_update
  BEFORE UPDATE ON decision_fragments
  FOR EACH ROW EXECUTE FUNCTION protect_human_action_fragments();--> statement-breakpoint

-- Note: we intentionally DO NOT add a BEFORE DELETE trigger here. Direct
-- DELETE of a human_action row by app code or a future route should be
-- blocked, but cascade DELETEs from a parent row (dossier or run) must be
-- allowed. Postgres fires row-level triggers on cascade deletes too, so a
-- BEFORE DELETE trigger that blocks human_action would break the dossier
-- delete path. If you ever expose direct fragment delete, enforce
-- immutability in the route handler (the /api/fragments/:id middleware
-- already does this in HTTP) rather than at the trigger level.

-- ----------------------------------------------------------------------------
-- §6.5 M-7 screening_evaluations.fragment_id → decision_fragments(id) SET NULL
-- The column is an FK in spirit but was never declared. Adding it makes the
-- audit chain consistent with the cascade fix above.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  fk_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'screening_evaluations'::regclass
      AND contype = 'f'
      AND pg_get_constraintdef(oid) LIKE '%(fragment_id)%'
  ) INTO fk_exists;

  IF NOT fk_exists THEN
    -- Null out any dangling references first.
    UPDATE screening_evaluations se
    SET fragment_id = NULL
    WHERE fragment_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM decision_fragments df WHERE df.id = se.fragment_id);

    ALTER TABLE screening_evaluations
      ADD CONSTRAINT screening_evaluations_fragment_id_fk
      FOREIGN KEY (fragment_id)
      REFERENCES decision_fragments(id) ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint

-- ----------------------------------------------------------------------------
-- §4.4 missing indexes for hot queries
-- These are all CREATE INDEX IF NOT EXISTS so safely re-runnable.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS decision_fragments_run_idx
  ON decision_fragments (run_id, sequence, started_at);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS decision_fragments_parent_idx
  ON decision_fragments (parent_fragment_id)
  WHERE parent_fragment_id IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS decision_fragments_kind_started_idx
  ON decision_fragments (kind, started_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS decision_fragments_node_id_idx
  ON decision_fragments (node_id);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS runs_dossier_started_idx
  ON runs (dossier_id, started_at DESC);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS dossiers_case_status_idx
  ON dossiers (case_status);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS screening_evaluations_fragment_idx
  ON screening_evaluations (fragment_id)
  WHERE fragment_id IS NOT NULL;
