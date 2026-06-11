-- API-state snapshot columns so a rescreen run can replay screening from a
-- prior run's profile/officers/psc/kycCard without re-fetching Companies House.
ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "final_profile" jsonb;

ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "final_officers" jsonb;

ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "final_psc" jsonb;
