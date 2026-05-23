/**
 * 性能测试专用 Seed 脚本
 * 创建 30 个 mock 学生并加入计算机网络基础课程
 *
 * 用法:
 *   cd edu-platform
 *   npx tsx tests/perf/seed_perf_users.ts
 *
 * 安全：可重复运行（upsert，已存在则跳过）
 */
import { PrismaClient, UserRole } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

// 与 utils.js 中 COURSE_ID 保持一致
const COURSE_ID   = "c8b8787f-9c7e-4f37-bab5-fb94a438d9cf";
const PASSWORD    = "MockStudent@2026";   // 满足 12 字符密码策略
const MOCK_COUNT  = 30;

async function main(): Promise<void> {
  // 验证课程存在
  const course = await prisma.course.findUnique({
    where:  { id: COURSE_ID },
    select: { id: true, name: true, status: true },
  });
  if (!course) {
    throw new Error(
      `课程 ${COURSE_ID} 不存在。请先确认数据库中存在该课程。\n` +
      `可用课程: SELECT id, name FROM courses WHERE status='PUBLISHED';`
    );
  }
  console.info(`目标课程: "${course.name}" (${course.id}) [${course.status}]`);

  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  let created = 0;
  let skipped = 0;

  for (let i = 1; i <= MOCK_COUNT; i++) {
    const idx      = String(i).padStart(2, "0");
    const username = `mock_student_${idx}`;
    const email    = `mock_student_${idx}@localhost.test`;

    // Upsert 用户
    let user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          username,
          email,
          passwordHash,
          role:     UserRole.STUDENT,
          realName: `压测学生 ${idx}`,
          isActive: true,
        },
      });
      created++;
      console.info(`  [+] 创建: ${username} (${user.id})`);
    } else {
      skipped++;
      console.info(`  [~] 已存在: ${username} (${user.id})`);
    }

    // Upsert 课程注册
    await prisma.courseEnrollment.upsert({
      where:  { courseId_studentId: { courseId: COURSE_ID, studentId: user.id } },
      create: { courseId: COURSE_ID, studentId: user.id },
      update: {},
    });
  }

  console.info(`\n完成。新建: ${created}，跳过(已存在): ${skipped}`);
  console.info(`\n账号信息:`);
  console.info(`  用户名: mock_student_01 … mock_student_30`);
  console.info(`  密码:   ${PASSWORD}`);
  console.info(`  邮箱:   mock_student_XX@localhost.test`);
  console.info(`  课程:   ${course.name} (${COURSE_ID})`);
}

main()
  .catch((e: unknown) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
