import { AssignmentStatus } from "@prisma/client";
import { ApiError } from "@/lib/http/api-error";

function assertStatus(
  status: AssignmentStatus,
  allowed: AssignmentStatus[],
  message: string,
): void {
  if (!allowed.includes(status)) {
    throw new ApiError(409, "CONFLICT", message);
  }
}

export function assertCanEditAssignment(status: AssignmentStatus): void {
  assertStatus(status, [AssignmentStatus.DRAFT], "Only DRAFT assignments can be edited");
}

export function assertCanPublishAssignment(status: AssignmentStatus): void {
  assertStatus(status, [AssignmentStatus.DRAFT], "Only DRAFT assignments can be published");
}

export function assertCanRegenerateAssignmentQuestion(status: AssignmentStatus): void {
  assertStatus(status, [AssignmentStatus.DRAFT], "Can only regenerate questions for DRAFT assignments");
}

export function assertCanPreviewAssignmentQuestion(status: AssignmentStatus): void {
  assertStatus(status, [AssignmentStatus.DRAFT], "Can only preview questions for DRAFT assignments");
}

export function assertCanAddAssignmentQuestion(status: AssignmentStatus): void {
  assertStatus(status, [AssignmentStatus.DRAFT], "Can only add questions to DRAFT assignments");
}

export function assertAssignmentIsPublished(status: AssignmentStatus): void {
  assertStatus(status, [AssignmentStatus.PUBLISHED], "Assignment is not published");
}
