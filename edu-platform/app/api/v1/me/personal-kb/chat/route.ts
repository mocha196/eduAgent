import type { NextRequest } from "next/server";
import { jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import { getOrCreatePersonalKbSession } from "@/lib/services/personalMaterialService";
import { personalKbChatSseResponse } from "@/lib/services/chatService";
import { prisma } from "@/lib/db";
import { assertUuid } from "@/lib/course-access";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const body = (await req.json()) as {
      message?: string;
      session_id?: string;
      material_id?: string;
      trim_history_to?: number;
    };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      throw new ApiError(400, "VALIDATION_ERROR", "message is required");
    }
    // Resolve session: use provided session_id if it belongs to this user, otherwise fall back to default
    let sessionId: string;
    if (body.session_id) {
      assertUuid(body.session_id, "session_id");
      const sessionRow = await prisma.personalKbSession.findFirst({
        where: { agentSessionId: body.session_id, userId: auth.sub },
        select: { agentSessionId: true },
      });
      if (!sessionRow) {
        throw new ApiError(404, "NOT_FOUND", "Personal KB session not found");
      }
      sessionId = sessionRow.agentSessionId;
    } else {
      const { agent_session_id } = await getOrCreatePersonalKbSession(auth.sub);
      sessionId = agent_session_id;
    }
    const trimHistoryTo =
      typeof body.trim_history_to === "number" &&
      Number.isInteger(body.trim_history_to) &&
      body.trim_history_to >= 0
        ? body.trim_history_to
        : undefined;
    // Validate material_id belongs to this user
    let materialId: string | null = null;
    if (body.material_id) {
      assertUuid(body.material_id, "material_id");
      const mat = await prisma.personalMaterial.findFirst({
        where: { id: body.material_id, userId: auth.sub, isDeleted: false },
      });
      if (!mat) {
        throw new ApiError(404, "NOT_FOUND", "Material not found");
      }
      materialId = mat.id;
    }
    const traceId = req.headers.get("x-trace-id")?.trim() || null;
    const debugTraceRaw = req.headers.get("x-debug-trace")?.trim().toLowerCase() || "";
    const debugTrace = ["1", "true", "yes", "on"].includes(debugTraceRaw);

    return await personalKbChatSseResponse({
      userId: auth.sub,
      message,
      sessionId,
      materialId,
      traceId,
      debugTrace,
      trimHistoryTo,
    });
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
