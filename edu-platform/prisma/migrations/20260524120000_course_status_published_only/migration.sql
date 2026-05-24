-- Normalize all courses to PUBLISHED before shrinking enum
UPDATE "courses" SET "status" = 'PUBLISHED' WHERE "status" IN ('DRAFT', 'ARCHIVED');

-- Backfill share_code for courses missing one (Crockford base32, 10 chars, no I/L/O/U)
DO $$
DECLARE
  r RECORD;
  new_code TEXT;
  alphabet TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  i INT;
  attempts INT;
  clash BOOLEAN;
BEGIN
  FOR r IN SELECT "id" FROM "courses" WHERE "share_code" IS NULL LOOP
    attempts := 0;
    LOOP
      new_code := '';
      FOR i IN 1..10 LOOP
        new_code := new_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
      END LOOP;
      SELECT EXISTS(SELECT 1 FROM "courses" WHERE "share_code" = new_code) INTO clash;
      EXIT WHEN NOT clash;
      attempts := attempts + 1;
      IF attempts > 40 THEN
        RAISE EXCEPTION 'Failed to allocate share_code for course %', r.id;
      END IF;
    END LOOP;
    UPDATE "courses" SET "share_code" = new_code WHERE "id" = r.id;
  END LOOP;
END $$;

-- Shrink CourseStatus enum to PUBLISHED only
CREATE TYPE "CourseStatus_new" AS ENUM ('PUBLISHED');

ALTER TABLE "courses" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "courses"
  ALTER COLUMN "status" TYPE "CourseStatus_new"
  USING ('PUBLISHED'::"CourseStatus_new");
ALTER TABLE "courses"
  ALTER COLUMN "status" SET DEFAULT 'PUBLISHED'::"CourseStatus_new";

DROP TYPE "CourseStatus";
ALTER TYPE "CourseStatus_new" RENAME TO "CourseStatus";
