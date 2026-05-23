/**
 * Shared objective-question grading for both AssignmentSubmission and MemoryReview.
 *
 * Grades by case-insensitive, trimmed string equality (all-or-nothing).
 * Supports single_choice, multi_choice (comma-separated), true_false, and fill_blank
 * when the answer is a short, deterministic string.
 */

export interface ObjectiveGradeResult {
  isCorrect: boolean;
  correctAnswer: string;
  feedback: string;
}

/**
 * Grade an objective question answer.
 * @param correctAnswer The canonical answer stored in the question record.
 * @param userAnswer    The answer provided by the student/reviewer.
 */
export function gradeObjectiveAnswer(
  correctAnswer: string,
  userAnswer: string,
): ObjectiveGradeResult {
  const normalise = (s: string) => s.trim().toLowerCase();
  const isCorrect = normalise(correctAnswer) === normalise(userAnswer);
  return {
    isCorrect,
    correctAnswer,
    feedback: isCorrect ? "回答正确。" : `正确答案为：${correctAnswer}`,
  };
}
