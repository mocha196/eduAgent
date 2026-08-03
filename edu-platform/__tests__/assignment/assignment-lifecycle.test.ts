import { describe, expect, it } from "vitest";
import { AssignmentStatus } from "@prisma/client";
import {
  assertAssignmentIsPublished,
  assertCanAddAssignmentQuestion,
  assertCanEditAssignment,
  assertCanPreviewAssignmentQuestion,
  assertCanPublishAssignment,
  assertCanRegenerateAssignmentQuestion,
} from "@/lib/domain/assignment-lifecycle";

describe("assignment lifecycle guards", () => {
  it("allows draft-only teacher actions", () => {
    expect(() => assertCanEditAssignment(AssignmentStatus.DRAFT)).not.toThrow();
    expect(() => assertCanPublishAssignment(AssignmentStatus.DRAFT)).not.toThrow();
    expect(() => assertCanRegenerateAssignmentQuestion(AssignmentStatus.DRAFT)).not.toThrow();
    expect(() => assertCanPreviewAssignmentQuestion(AssignmentStatus.DRAFT)).not.toThrow();
    expect(() => assertCanAddAssignmentQuestion(AssignmentStatus.DRAFT)).not.toThrow();
  });

  it("blocks non-draft teacher actions", () => {
    expect(() => assertCanEditAssignment(AssignmentStatus.PUBLISHED)).toThrow();
    expect(() => assertCanPublishAssignment(AssignmentStatus.FAILED)).toThrow();
    expect(() => assertCanRegenerateAssignmentQuestion(AssignmentStatus.GENERATING)).toThrow();
  });

  it("only treats published assignments as student-visible", () => {
    expect(() => assertAssignmentIsPublished(AssignmentStatus.PUBLISHED)).not.toThrow();
    expect(() => assertAssignmentIsPublished(AssignmentStatus.DRAFT)).toThrow();
  });
});
