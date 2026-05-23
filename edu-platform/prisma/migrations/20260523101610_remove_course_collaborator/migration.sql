/*
  Warnings:

  - You are about to drop the `course_collaborators` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "course_collaborators" DROP CONSTRAINT "course_collaborators_course_id_fkey";

-- DropForeignKey
ALTER TABLE "course_collaborators" DROP CONSTRAINT "course_collaborators_teacher_id_fkey";

-- DropTable
DROP TABLE "course_collaborators";
