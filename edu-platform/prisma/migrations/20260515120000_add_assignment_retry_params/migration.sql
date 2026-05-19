-- AlterTable
ALTER TABLE "assignments"
  ADD COLUMN IF NOT EXISTS "teacher_request" TEXT,
  ADD COLUMN IF NOT EXISTS "structured_params" JSONB;
