import { logger } from "@/lib/logger";
import { isOfficeMaterialFileType } from "@/lib/material-office";
import { enqueueRagTask, type RagQueueTask } from "@/lib/queue/ragTask";
import contract from "@/lib/material-ingestion.contract.json";

const log = logger.child({ component: "material-ingestion" });

const MEDIA_FILE_TYPES = new Set([
  "mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv",
  "mp3", "wav", "m4a", "flac", "ogg", "opus",
]);

export type MaterialScope = "course" | "personal";
type MaterialKind = "office" | "media" | "document";

// The manifest is checked against the Python worker's handler registry in tests.
const INITIAL_OPERATIONS = contract.initial_operations as Record<
  MaterialScope,
  Record<MaterialKind, RagQueueTask["operation"]>
>;

/** Keep the first task decision in one place for both material owners. */
export function initialMaterialOperation(
  scope: MaterialScope,
  fileType: string,
): RagQueueTask["operation"] {
  const kind: MaterialKind = isOfficeMaterialFileType(fileType)
    ? "office"
    : isVideoOrAudioMaterialFileType(fileType)
      ? "media"
      : "document";
  return INITIAL_OPERATIONS[scope][kind];
}

export function isVideoOrAudioMaterialFileType(fileType: string): boolean {
  return MEDIA_FILE_TYPES.has(fileType.toLowerCase());
}

/** A timeout after XADD may still have published the task; consumers must remain idempotent. */
export async function enqueueMaterialTaskWithRetry(
  task: RagQueueTask,
  maxAttempts = 5,
): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await enqueueRagTask(task);
      return;
    } catch (error) {
      last = error;
      log.warn(
        {
          error: error instanceof Error ? error.message : String(error),
          attempt,
          maxAttempts,
          operation: task.operation,
          materialId: task.material_id,
        },
        "Material task enqueue failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  throw last;
}
