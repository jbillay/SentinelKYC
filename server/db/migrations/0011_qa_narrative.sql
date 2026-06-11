-- QA narrative — LLM-generated regulator-defensible recommendation produced by
-- the qa_narrative node, which runs after qa_check in both compiledGraph and
-- compiledScreeningOnlyGraph. Nullable so pre-existing runs continue to render
-- "narrative not yet generated".
--
-- Shape:
--   { text, paragraphCount, tier, model, promptVersionId, generatedAt }
-- See server/services/qa/narrative.js.

ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "qa_narrative" jsonb;
