-- CreateEnum (skip if already exists)
-- personal_materials and personal_kb_sessions tables

CREATE TABLE IF NOT EXISTS "personal_materials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "minio_path" TEXT NOT NULL,
    "preview_pdf_status" "MaterialPreviewPdfStatus" NOT NULL DEFAULT 'NA',
    "status" "MaterialStatus" NOT NULL DEFAULT 'UPLOADED',
    "status_message" TEXT,
    "indexed_chunk_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "personal_materials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "personal_kb_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "agent_session_id" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_kb_sessions_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
ALTER TABLE "personal_kb_sessions" DROP CONSTRAINT IF EXISTS "personal_kb_sessions_user_id_key";
ALTER TABLE "personal_kb_sessions" ADD CONSTRAINT "personal_kb_sessions_user_id_key" UNIQUE ("user_id");

ALTER TABLE "personal_kb_sessions" DROP CONSTRAINT IF EXISTS "personal_kb_sessions_agent_session_id_key";
ALTER TABLE "personal_kb_sessions" ADD CONSTRAINT "personal_kb_sessions_agent_session_id_key" UNIQUE ("agent_session_id");

-- Indexes
CREATE INDEX IF NOT EXISTS "personal_materials_user_id_status_idx" ON "personal_materials"("user_id", "status");

-- Foreign keys
ALTER TABLE "personal_materials" DROP CONSTRAINT IF EXISTS "personal_materials_user_id_fkey";
ALTER TABLE "personal_materials" ADD CONSTRAINT "personal_materials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "personal_kb_sessions" DROP CONSTRAINT IF EXISTS "personal_kb_sessions_user_id_fkey";
ALTER TABLE "personal_kb_sessions" ADD CONSTRAINT "personal_kb_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
