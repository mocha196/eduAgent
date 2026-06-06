import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const USER_ID = "db0caf7b-2211-43b1-8eac-cda72f062215";
// Delete all sessions for test_student so we can re-dispatch
void p.memoryReviewSession.deleteMany({
  where: { userId: USER_ID },
}).then((r) => {
  console.log(`Deleted ${r.count} session(s) for test_student`);
  return p.$disconnect();
});
