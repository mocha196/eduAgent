ALTER TABLE "assignment_submissions"
ADD COLUMN "grading_token" UUID,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "notifications"
ADD COLUMN "dedup_key" VARCHAR(255);

CREATE UNIQUE INDEX "notifications_user_id_dedup_key_key"
ON "notifications"("user_id", "dedup_key");
