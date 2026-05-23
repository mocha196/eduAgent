-- ============================================================
-- Reconciliation migration: captures schema changes that were
-- applied directly to the DB without migration files.
-- This migration is marked as already-applied via
--   prisma migrate resolve --applied
-- The SQL below is written to be safe when replayed by shadow DB
-- from scratch (after the preceding migration chain).
-- ============================================================

-- 1. Drop the DB-level default from chunk_page_mappings.id
--    (The CREATE TABLE in add_chunk_page_mappings set DEFAULT gen_random_uuid(),
--     but Prisma now generates UUIDs in the application layer.)
ALTER TABLE "chunk_page_mappings" ALTER COLUMN "id" DROP DEFAULT;

-- 2. Drop the DB-level defaults from personal_kb_sessions.id and personal_materials.id
ALTER TABLE "personal_kb_sessions" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "personal_materials" ALTER COLUMN "id" DROP DEFAULT;

-- 3. course_chat_sessions: replace unique index with regular index, add deleted_at
ALTER TABLE "course_chat_sessions" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP;
DROP INDEX IF EXISTS "course_chat_sessions_course_id_student_id_key";
CREATE INDEX IF NOT EXISTS "course_chat_sessions_course_id_student_id_idx" ON "course_chat_sessions"("course_id", "student_id");
CREATE INDEX IF NOT EXISTS "course_chat_sessions_student_id_idx" ON "course_chat_sessions"("student_id");

-- 4. Enums for assignment submissions
DO $$ BEGIN
  CREATE TYPE "SubmissionStatus" AS ENUM ('SUBMITTED', 'GRADING', 'GRADED', 'RETURNED');
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "GradeSource" AS ENUM ('AUTO', 'AI', 'TEACHER');
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. assignment_submissions table
CREATE TABLE IF NOT EXISTS "assignment_submissions" (
    "id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "answers" JSONB NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
    "grading_result" JSONB,
    "teacher_feedback" TEXT,
    "submitted_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "graded_at" TIMESTAMP,
    "returned_at" TIMESTAMP,
    CONSTRAINT "assignment_submissions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "assignment_submissions_assignment_id_student_id_key"
    ON "assignment_submissions"("assignment_id", "student_id");
CREATE INDEX IF NOT EXISTS "assignment_submissions_assignment_id_idx"
    ON "assignment_submissions"("assignment_id");
CREATE INDEX IF NOT EXISTS "assignment_submissions_student_id_idx"
    ON "assignment_submissions"("student_id");
DO $$ BEGIN
  ALTER TABLE "assignment_submissions"
    ADD CONSTRAINT "assignment_submissions_assignment_id_fkey"
    FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "assignment_submissions"
    ADD CONSTRAINT "assignment_submissions_student_id_fkey"
    FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
