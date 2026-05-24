-- Add denormalised total_score and max_score columns to assignment_submissions
ALTER TABLE "assignment_submissions" ADD COLUMN "total_score" INTEGER;
ALTER TABLE "assignment_submissions" ADD COLUMN "max_score" INTEGER;

-- Back-fill from existing grading_result JSON (for already-graded submissions)
UPDATE "assignment_submissions"
SET
  "total_score" = (grading_result->>'totalScore')::INTEGER,
  "max_score"   = (grading_result->>'maxScore')::INTEGER
WHERE grading_result IS NOT NULL;
