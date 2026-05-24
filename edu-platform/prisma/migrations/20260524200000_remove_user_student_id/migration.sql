-- AlterTable: remove student_id column from users (previously added as optional unique field)
ALTER TABLE "users" DROP COLUMN "student_id";
