import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const studentId = "db0caf7b-2211-43b1-8eac-cda72f062215";
  const courseId = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf";

  const existing = await prisma.courseEnrollment.findUnique({
    where: { courseId_studentId: { courseId, studentId } },
  });
  if (existing) {
    console.log("已加入课程，enrollmentId:", existing.id);
    return;
  }

  const enrollment = await prisma.courseEnrollment.create({
    data: { courseId, studentId },
  });
  console.log("✓ 加入成功, enrollmentId:", enrollment.id);
  console.log("  courseId :", courseId);
  console.log("  studentId:", studentId);
}

main()
  .catch((e) => { console.error("失败:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
