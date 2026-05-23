-- AlterTable (wrapped in DO block: table may not exist yet on a clean replay)
DO $$ BEGIN
  IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chunk_page_mappings') THEN
    ALTER TABLE "chunk_page_mappings" ALTER COLUMN "id" DROP DEFAULT;
  END IF;
END $$;
