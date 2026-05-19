-- CreateEnum
CREATE TYPE "PersonalKnowledgeSourceStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "PersonalWikiPageType" AS ENUM ('index', 'log', 'entity', 'concept', 'summary');

-- AlterTable: add personal wiki LLM config fields to users
ALTER TABLE "users"
  ADD COLUMN "personal_wiki_model" TEXT,
  ADD COLUMN "personal_wiki_base_url" TEXT,
  ADD COLUMN "personal_wiki_api_key" TEXT;

-- CreateTable: personal_knowledge_sources
CREATE TABLE "personal_knowledge_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "original_filename" TEXT NOT NULL,
  "file_type" TEXT NOT NULL,
  "file_size" INTEGER NOT NULL,
  "minio_path" TEXT NOT NULL,
  "status" "PersonalKnowledgeSourceStatus" NOT NULL DEFAULT 'UPLOADED',
  "status_message" TEXT,
  "wiki_page_slugs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "personal_knowledge_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable: personal_wiki_pages
CREATE TABLE "personal_wiki_pages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "slug" VARCHAR(255) NOT NULL,
  "title" TEXT NOT NULL,
  "type" "PersonalWikiPageType" NOT NULL,
  "content" TEXT NOT NULL,
  "source_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "personal_wiki_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "personal_knowledge_sources_user_id_status_idx" ON "personal_knowledge_sources"("user_id", "status");
CREATE INDEX "personal_knowledge_sources_user_id_created_at_idx" ON "personal_knowledge_sources"("user_id", "created_at" DESC);

CREATE UNIQUE INDEX "personal_wiki_pages_user_id_slug_key" ON "personal_wiki_pages"("user_id", "slug");
CREATE INDEX "personal_wiki_pages_user_id_type_idx" ON "personal_wiki_pages"("user_id", "type");
CREATE INDEX "personal_wiki_pages_user_id_updated_at_idx" ON "personal_wiki_pages"("user_id", "updated_at" DESC);

-- AddForeignKey
ALTER TABLE "personal_knowledge_sources"
  ADD CONSTRAINT "personal_knowledge_sources_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "personal_wiki_pages"
  ADD CONSTRAINT "personal_wiki_pages_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Trigger to auto-update updated_at on personal_knowledge_sources
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER personal_knowledge_sources_updated_at
  BEFORE UPDATE ON "personal_knowledge_sources"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER personal_wiki_pages_updated_at
  BEFORE UPDATE ON "personal_wiki_pages"
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
