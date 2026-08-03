import { AssignmentStatus, SubmissionStatus } from "@prisma/client";
import { ApiError, type ApiErrorCode } from "@/lib/http/api-error";

function assertStatus(
  status: SubmissionStatus,
  allowed: SubmissionStatus[],
  message: string,
  code: ApiErrorCode = "CONFLICT",
): void {
  if (!allowed.includes(status)) {
    throw new ApiError(400, code, message);
  }
}

export function assertCanSubmitAssignment(
  assignmentStatus: AssignmentStatus,
  deadline: Date | null,
  now = new Date(),
): void {
  if (assignmentStatus !== AssignmentStatus.PUBLISHED) {
    throw new ApiError(400, "NOT_PUBLISHED", "Assignment is not published");
  }
  if (deadline && now > deadline) {
    throw new ApiError(403, "DEADLINE_PASSED", "Submission deadline has passed");
  }
}

export function assertCanResubmitSubmission(status: SubmissionStatus | null | undefined): void {
  if (status === SubmissionStatus.RETURNED) {
    throw new ApiError(409, "ALREADY_RETURNED", "Your submission has already been returned; re-submission is not allowed");
  }
}

export function shouldSkipAutoGrading(status: SubmissionStatus): boolean {
  return status === SubmissionStatus.RETURNED;
}

export function assertCanReadStudentGrading(status: SubmissionStatus): void {
  assertStatus(status, [SubmissionStatus.RETURNED], "Grades are only visible after teacher returns them", "GRADING_IN_PROGRESS");
}

export function assertCanOverrideSubmissionGrades(status: SubmissionStatus): void {
  assertStatus(status, [SubmissionStatus.GRADED, SubmissionStatus.RETURNED], "Submission has not been graded yet", "NOT_GRADED");
}

export function assertCanReturnSubmission(status: SubmissionStatus): void {
  assertStatus(status, [SubmissionStatus.GRADED, SubmissionStatus.RETURNED], "Submission must be in GRADED status to return", "NOT_GRADED");
}
