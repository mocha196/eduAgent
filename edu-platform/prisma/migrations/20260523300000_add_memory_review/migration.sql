-- Add MEMORY_REVIEW_READY to NotificationType enum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MEMORY_REVIEW_READY';

-- Create MemoryReviewSessionStatus enum
DO $$ BEGIN
  CREATE TYPE "MemoryReviewSessionStatus" AS ENUM (
    'PENDING',
    'IN_PROGRESS',
    'COMPLETED',
    'DISMISSED',
    'EXPIRED'
  );
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create MemoryReviewQuestionType enum
DO $$ BEGIN
  CREATE TYPE "MemoryReviewQuestionType" AS ENUM (
    'SINGLE_CHOICE',
    'FILL_BLANK',
    'TRUE_FALSE'
  );
  EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Create user_memory_review_preferences table
CREATE TABLE IF NOT EXISTS "user_memory_review_preferences" (
    "id"         UUID         NOT NULL,
    "user_id"    UUID         NOT NULL,
    "enabled"    BOOLEAN      NOT NULL DEFAULT true,
    "local_time" VARCHAR(5)   NOT NULL DEFAULT '09:00',
    "timezone"   VARCHAR(64)  NOT NULL DEFAULT 'Asia/Shanghai',
    CONSTRAINT "user_memory_review_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_memory_review_preferences_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_memory_review_preferences_user_id_key"
    ON "user_memory_review_preferences"("user_id");

-- Create memory_review_sessions table
CREATE TABLE IF NOT EXISTS "memory_review_sessions" (
    "id"             UUID                        NOT NULL,
    "user_id"        UUID                        NOT NULL,
    "scheduled_date" VARCHAR(10)                 NOT NULL,
    "status"         "MemoryReviewSessionStatus" NOT NULL DEFAULT 'PENDING',
    "question_count" INTEGER                     NOT NULL DEFAULT 0,
    "expires_at"     TIMESTAMP(3)                NOT NULL,
    "created_at"     TIMESTAMP(3)                NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3)                NOT NULL,
    CONSTRAINT "memory_review_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_review_sessions_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "memory_review_sessions_user_id_scheduled_date_key"
    ON "memory_review_sessions"("user_id", "scheduled_date");

CREATE INDEX IF NOT EXISTS "memory_review_sessions_user_id_status_idx"
    ON "memory_review_sessions"("user_id", "status");

-- Create memory_review_questions table
CREATE TABLE IF NOT EXISTS "memory_review_questions" (
    "id"           UUID                      NOT NULL,
    "session_id"   UUID                      NOT NULL,
    "course_id"    UUID,
    "concept_id"   UUID,
    "concept_name" TEXT                      NOT NULL,
    "type"         "MemoryReviewQuestionType" NOT NULL,
    "stem"         TEXT                      NOT NULL,
    "options_json" JSONB,
    "answer"       TEXT                      NOT NULL,
    "explanation"  TEXT                      NOT NULL,
    "user_answer"  TEXT,
    "is_correct"   BOOLEAN,
    "answered_at"  TIMESTAMP(3),
    "created_at"   TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_review_questions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "memory_review_questions_session_id_fkey"
        FOREIGN KEY ("session_id") REFERENCES "memory_review_sessions"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "memory_review_questions_session_id_idx"
    ON "memory_review_questions"("session_id");
