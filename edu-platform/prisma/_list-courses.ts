import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
p.course.findMany({ select: { id: true, name: true, status: true } })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); })
  .finally(() => p.$disconnect());
