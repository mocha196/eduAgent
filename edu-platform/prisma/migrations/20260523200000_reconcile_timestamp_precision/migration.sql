-- Reconcile TIMESTAMP precision drift.
--
-- The migrations in reconcile_drift and add_notifications used hand-written
-- `CREATE TABLE IF NOT EXISTS ... TIMESTAMP` (no precision), which PostgreSQL
-- treats as TIMESTAMP(6).  Prisma maps DateTime to TIMESTAMP(3) and the
-- actual database already has TIMESTAMP(3) because those tables existed
-- before the IF-NOT-EXISTS guards ran.  This migration fixes the shadow-DB
-- so Prisma's replay produces TIMESTAMP(3) in both environments.

ALTER TABLE "assignment_submissions"
  ALTER COLUMN "submitted_at" TYPE TIMESTAMP(3),
  ALTER COLUMN "graded_at"    TYPE TIMESTAMP(3),
  ALTER COLUMN "returned_at"  TYPE TIMESTAMP(3);

ALTER TABLE "course_chat_sessions"
  ALTER COLUMN "deleted_at" TYPE TIMESTAMP(3);

ALTER TABLE "notifications"
  ALTER COLUMN "created_at" TYPE TIMESTAMP(3);
