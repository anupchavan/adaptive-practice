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

	const recent = trailingCorrectResults(answered);
	const recentTwo = recent.slice(-2);
	const lastDifficulty = last.question.difficulty;
	const lastFluent = last.timeTakenMs <= expectedTimeMs(last.question);
	const fluentCorrect =
		recentTwo.length >= 2 &&
		recentTwo.every((result) =>
			!result.skipped &&
			result.isCorrect &&
			result.timeTakenMs <= expectedTimeMs(result.question) * 0.85
		);
	if (fluentCorrect) return "hard";
	if (lastDifficulty === "easy") return "medium";
	if (lastDifficulty === "medium") {
		if (recent.length >= 2) return "hard";
		if (lastFluent) return "medium";
		return null;
	}
	if (lastDifficulty === "hard") {
		return lastFluent ? "hard" : "medium";
	}
	return null;
}

function trailingCorrectResults(results: QuizResult[]): QuizResult[] {
	const out: QuizResult[] = [];
	for (let i = results.length - 1; i >= 0; i--) {
		const result = results[i]!;
		if (result.skipped || !result.isCorrect) break;
		out.unshift(result);
	}
	return out;
}
