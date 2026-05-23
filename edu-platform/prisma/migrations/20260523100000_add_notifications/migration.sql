-- Create NotificationType enum (safe: no-op if already exists)
DO $$ BEGIN
  CREATE TYPE "NotificationType" AS ENUM (
    'MATERIAL_UPLOADED',
    'MATERIAL_READY',
    'ASSIGNMENT_GENERATED',
    'ASSIGNMENT_FAILED',
    'ASSIGNMENT_PUBLISHED',
    'SUBMISSION_RECEIVED',
    'GRADE_RETURNED'
  );
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create notifications table (safe: no-op if already exists)
CREATE TABLE IF NOT EXISTS "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "notifications_user_id_is_read_created_at_idx"
    ON "notifications"("user_id", "is_read", "created_at" DESC);

DO $$ BEGIN
  ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
