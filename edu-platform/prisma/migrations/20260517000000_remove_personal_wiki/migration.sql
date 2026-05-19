-- Drop triggers
DROP TRIGGER IF EXISTS personal_knowledge_sources_updated_at ON "personal_knowledge_sources";
DROP TRIGGER IF EXISTS personal_wiki_pages_updated_at ON "personal_wiki_pages";

-- Drop tables (FK constraints dropped automatically with CASCADE)
DROP TABLE IF EXISTS "personal_wiki_pages";
DROP TABLE IF EXISTS "personal_knowledge_sources";

-- Drop columns from users
ALTER TABLE "users"
  DROP COLUMN IF EXISTS "personal_wiki_model",
  DROP COLUMN IF EXISTS "personal_wiki_base_url",
  DROP COLUMN IF EXISTS "personal_wiki_api_key";

-- Drop enums
DROP TYPE IF EXISTS "PersonalWikiPageType";
DROP TYPE IF EXISTS "PersonalKnowledgeSourceStatus";
