-- DropConstraint (unique constraint on user_id)
ALTER TABLE "personal_kb_sessions" DROP CONSTRAINT IF EXISTS "personal_kb_sessions_user_id_key";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "personal_kb_sessions_user_id_idx" ON "personal_kb_sessions"("user_id");
