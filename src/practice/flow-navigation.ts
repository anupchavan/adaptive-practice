import { Question, QuizResult } from "../types";
import { expectedTimeMs } from "./grader";

export function adaptQuestionOrderForFlow(
	questions: Question[],
	results: Array<QuizResult | undefined>,
	currentIndex: number
): void {
	const targetDifficulty = nextTargetDifficulty(results);
	if (!targetDifficulty) return;
	const nextIndex = currentIndex + 1;
	if (nextIndex >= questions.length) return;

	const candidateIndex = questions.findIndex((question, index) =>
		index > currentIndex &&
		!results[index] &&
		question.difficulty === targetDifficulty
	);
	if (candidateIndex <= nextIndex) return;
	[questions[nextIndex], questions[candidateIndex]] = [
		questions[candidateIndex]!,
		questions[nextIndex]!,
	];
}

export function nextTargetDifficulty(
	results: Array<QuizResult | undefined>
): Question["difficulty"] | null {
	const answered = results.filter((result): result is QuizResult => !!result);
	if (answered.length === 0) return null;
	const last = answered[answered.length - 1]!;
	if (last.skipped || !last.isCorrect) return "easy";

	const recent = answered.slice(-2);
	const fluentCorrect =
		recent.length >= 2 &&
		recent.every((result) =>
			!result.skipped &&
			result.isCorrect &&
			result.timeTakenMs <= expectedTimeMs(result.question) * 0.85
		);
	if (fluentCorrect) return "hard";
	if (last.isCorrect && last.timeTakenMs <= expectedTimeMs(last.question)) {
		return "medium";
	}
	return null;
}
