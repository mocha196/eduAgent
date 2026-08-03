import { describe, expect, it } from "vitest";
import { AssignmentStatus, SubmissionStatus } from "@prisma/client";
import {
  assertCanOverrideSubmissionGrades,
  assertCanReadStudentGrading,
  assertCanResubmitSubmission,
  assertCanReturnSubmission,
  assertCanSubmitAssignment,
  shouldSkipAutoGrading,
} from "@/lib/domain/submission-lifecycle";

describe("submission lifecycle guards", () => {
  it("allows published assignments before deadline", () => {
    expect(() => assertCanSubmitAssignment(AssignmentStatus.PUBLISHED, null)).not.toThrow();
    expect(() => assertCanSubmitAssignment(AssignmentStatus.PUBLISHED, new Date(Date.now() + 60_000))).not.toThrow();
  });

  it("blocks unpublished or expired assignments", () => {
    expect(() => assertCanSubmitAssignment(AssignmentStatus.DRAFT, null)).toThrow();
    expect(() => assertCanSubmitAssignment(AssignmentStatus.PUBLISHED, new Date(Date.now() - 60_000))).toThrow();
  });

  it("prevents resubmission after RETURNED", () => {
    expect(() => assertCanResubmitSubmission(SubmissionStatus.SUBMITTED)).not.toThrow();
    expect(() => assertCanResubmitSubmission(SubmissionStatus.RETURNED)).toThrow();
  });

  it("only exposes grading details after RETURNED", () => {
    expect(() => assertCanReadStudentGrading(SubmissionStatus.RETURNED)).not.toThrow();
    expect(() => assertCanReadStudentGrading(SubmissionStatus.GRADED)).toThrow();
  });

  it("allows teacher review actions only after grading", () => {
    expect(() => assertCanOverrideSubmissionGrades(SubmissionStatus.GRADED)).not.toThrow();
    expect(() => assertCanOverrideSubmissionGrades(SubmissionStatus.RETURNED)).not.toThrow();
    expect(() => assertCanReturnSubmission(SubmissionStatus.GRADED)).not.toThrow();
    expect(() => assertCanOverrideSubmissionGrades(SubmissionStatus.SUBMITTED)).toThrow();
    expect(() => assertCanReturnSubmission(SubmissionStatus.GRADING)).toThrow();
  });

  it("skips auto grading only for returned submissions", () => {
    expect(shouldSkipAutoGrading(SubmissionStatus.RETURNED)).toBe(true);
    expect(shouldSkipAutoGrading(SubmissionStatus.SUBMITTED)).toBe(false);
  });
});
