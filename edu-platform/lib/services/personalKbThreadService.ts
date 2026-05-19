import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/api-error";
import { sessionStore } from "@/lib/agent/session-store";
import type { Message } from "@/lib/agent/types";

export type PersonalKbThreadMessage = {
  id: string;
  question: string;
  answer: string | null;
  tool_calls: unknown[];
  citations: unknown[];
};

async function assertPersonalKbSessionOwner(
  userId: string,
  sessionId: string,
): Promise<void> {
  const row = await prisma.personalKbSession.findFirst({
    where: {
      userId,
      agentSessionId: sessionId,
    },
    select: { id: true },
  });
  if (!row) {
    throw new ApiError(404, "NOT_FOUND", "会话不存在");
  }
}

function toThreadMessages(sessionId: string, rows: Message[]): PersonalKbThreadMessage[] {
  const out: PersonalKbThreadMessage[] = [];
  let pendingUser: Message | null = null;
  let idx = 0;

  for (const row of rows) {
    if (row.role === "user") {
      pendingUser = row;
      continue;
    }
    if (row.role !== "assistant") {
      continue;
    }

    const question = pendingUser?.content ?? "";
    out.push({
      id: `${sessionId}:${idx}`,
      question,
      answer: row.content ?? "",
      tool_calls: [],
      citations: [],
    });
    idx += 1;
    pendingUser = null;
  }

  if (pendingUser) {
    out.push({
      id: `${sessionId}:${idx}`,
      question: pendingUser.content,
      answer: null,
      tool_calls: [],
      citations: [],
    });
  }

  return out;
}

export async function getPersonalKbThreadMessages(
  userId: string,
  sessionId: string,
): Promise<PersonalKbThreadMessage[]> {
  await assertPersonalKbSessionOwner(userId, sessionId);
  try {
    const rows = await sessionStore.get(sessionId);
    return toThreadMessages(sessionId, rows);
  } catch (e) {
    throw new ApiError(503, "SERVICE_UNAVAILABLE", "会话历史暂不可用", {
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
