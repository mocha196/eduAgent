-- Add transcript_text and video_summary columns to materials and personal_materials

ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "transcript_text" TEXT;
ALTER TABLE "materials" ADD COLUMN IF NOT EXISTS "video_summary" TEXT;

ALTER TABLE "personal_materials" ADD COLUMN IF NOT EXISTS "transcript_text" TEXT;
ALTER TABLE "personal_materials" ADD COLUMN IF NOT EXISTS "video_summary" TEXT;
