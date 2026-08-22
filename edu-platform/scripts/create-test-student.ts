/**
 * 直接用 Prisma 创建测试学生账号，绕过 HTTP API
 * 运行: npx tsx scripts/create-test-student.ts
 */
import { PrismaClient, UserRole } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

async function main() {
  const username = "S2026001";
  const password = "test123456";
  const realName = "功能测试学生";

  // 检查是否已存在
  const existing = await prisma.user.findFirst({
    where: { username },
  });

  if (existing) {
    console.log("学生已存在:");
    console.log("  id      :", existing.id);
    console.log("  username:", existing.username);
    console.log("  role    :", existing.role);
    console.log("  初始密码:", password, "(如已修改则以实际为准)");
    return;
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
      role: UserRole.STUDENT,
      realName,
      isActive: true,
    },
  });

  console.log("✓ 测试学生创建成功:");
  console.log("  id       :", user.id);
  console.log("  username :", user.username);
  console.log("  密码     :", password);
}

main()
  .catch((e) => {
    console.error("创建失败:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
