UPDATE "assignments"
SET "status" = 'PUBLISHED'
WHERE "status" = 'ARCHIVED';

ALTER TYPE "AssignmentStatus" RENAME TO "AssignmentStatus_old";

CREATE TYPE "AssignmentStatus" AS ENUM ('GENERATING', 'FAILED', 'DRAFT', 'PUBLISHED');

ALTER TABLE "assignments"
ALTER COLUMN "status" DROP DEFAULT,
ALTER COLUMN "status" TYPE "AssignmentStatus"
USING ("status"::text::"AssignmentStatus"),
ALTER COLUMN "status" SET DEFAULT 'GENERATING';

DROP TYPE "AssignmentStatus_old";
