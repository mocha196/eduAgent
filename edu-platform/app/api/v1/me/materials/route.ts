import type { NextRequest } from "next/server";
import { Readable } from "node:stream";
import { jsonOk, jsonError } from "@/lib/http/json-response";
import { ApiError } from "@/lib/http/api-error";
import { requireAuthenticated } from "@/lib/admin";
import { getAuthFromRequest } from "@/lib/request-auth";
import {
  listPersonalMaterials,
  uploadPersonalMaterialStream,
} from "@/lib/services/personalMaterialService";

export const dynamic = "force-dynamic";

function parseBool(v: FormDataEntryValue | null): boolean {
  if (typeof v !== "string") return true;
  const s = v.trim().toLowerCase();
  if (!s) return true;
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

export async function GET(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const out = await listPersonalMaterials(auth.sub);
    return jsonOk(out);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = requireAuthenticated(await getAuthFromRequest(req));
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "VALIDATION_ERROR", "multipart field 'file' is required");
    }
    const textOnly = parseBool(form.get("text_only"));
    const skipKg = parseBool(form.get("skip_kg"));
    const stream = Readable.fromWeb(file.stream() as import("node:stream/web").ReadableStream<Uint8Array>);
    const created = await uploadPersonalMaterialStream({
      userId: auth.sub,
      originalFilename: file.name,
      contentType: file.type || undefined,
      contentLength: file.size,
      body: stream,
      textOnly,
      skipKg,
    });
    return jsonOk(created);
  } catch (e) {
    if (e instanceof ApiError) return jsonError(e);
    console.error("[api/me/materials] unexpected upload error", e);
    return jsonError(new ApiError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
