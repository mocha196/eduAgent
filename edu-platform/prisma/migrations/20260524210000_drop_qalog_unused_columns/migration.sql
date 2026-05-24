-- Drop obsolete columns from qa_logs:
--   lesson_id       — was linking Q&A to a specific lesson, always NULL in practice
--   response_quality — planned quality score (1-5), never written
--   is_helpful      — planned user thumbs-up feedback, never implemented
--   agent_feedback  — planned LLM self-evaluation text, never implemented

ALTER TABLE "qa_logs" DROP COLUMN "lesson_id";
ALTER TABLE "qa_logs" DROP COLUMN "response_quality";
ALTER TABLE "qa_logs" DROP COLUMN "is_helpful";
ALTER TABLE "qa_logs" DROP COLUMN "agent_feedback";
