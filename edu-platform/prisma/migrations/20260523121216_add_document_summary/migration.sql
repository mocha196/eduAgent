-- DropForeignKey
ALTER TABLE "memory_review_questions" DROP CONSTRAINT "memory_review_questions_session_id_fkey";

-- DropForeignKey
ALTER TABLE "memory_review_sessions" DROP CONSTRAINT "memory_review_sessions_user_id_fkey";

-- DropForeignKey
ALTER TABLE "user_memory_review_preferences" DROP CONSTRAINT "user_memory_review_preferences_user_id_fkey";

-- AlterTable
ALTER TABLE "materials" ADD COLUMN     "document_summary" TEXT;

-- AlterTable
ALTER TABLE "personal_materials" ADD COLUMN     "document_summary" TEXT;

-- AddForeignKey
ALTER TABLE "user_memory_review_preferences" ADD CONSTRAINT "user_memory_review_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_review_sessions" ADD CONSTRAINT "memory_review_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_review_questions" ADD CONSTRAINT "memory_review_questions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "memory_review_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
