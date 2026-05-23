import { describe, expect, it, vi, beforeEach } from "vitest";

const { findFirstCourseMock, findUniqueEnrollMock } =
  vi.hoisted(() => ({
    findFirstCourseMock: vi.fn(),
    findUniqueEnrollMock: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    course: { findFirst: findFirstCourseMock },
    courseEnrollment: { findUnique: findUniqueEnrollMock },
  },
}));

import { hasCourseRagAccess } from "@/lib/course-access";

const COURSE_ID = "550e8400-e29b-41d4-a716-446655440000";
const OWNER_ID = "660e8400-e29b-41d4-a716-446655440001";

describe("hasCourseRagAccess", () => {
  beforeEach(() => {
    findFirstCourseMock.mockReset();
    findUniqueEnrollMock.mockReset();
  });

  it("returns true for course owner", async () => {
    findFirstCourseMock.mockResolvedValue({
      id: COURSE_ID,
      teacherId: OWNER_ID,
      isDeleted: false,
    });
    expect(await hasCourseRagAccess(OWNER_ID, COURSE_ID)).toBe(true);
    expect(findUniqueEnrollMock).not.toHaveBeenCalled();
  });

  it("returns true for enrolled student", async () => {
    findFirstCourseMock.mockResolvedValue({
      id: COURSE_ID,
      teacherId: OWNER_ID,
      isDeleted: false,
    });
    findUniqueEnrollMock.mockResolvedValue({ id: "x" });
    const studentId = "990e8400-e29b-41d4-a716-446655440004";
    expect(await hasCourseRagAccess(studentId, COURSE_ID)).toBe(true);
  });

  it("returns false when no access", async () => {
    findFirstCourseMock.mockResolvedValue({
      id: COURSE_ID,
      teacherId: OWNER_ID,
      isDeleted: false,
    });
    findUniqueEnrollMock.mockResolvedValue(null);
    const stranger = "aa0e8400-e29b-41d4-a716-446655440005";
    expect(await hasCourseRagAccess(stranger, COURSE_ID)).toBe(false);
  });
});
