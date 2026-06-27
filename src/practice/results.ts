import { Question, QuizResult } from "../types";

export function compactQuizResults(
	results: Array<QuizResult | null | undefined>
): QuizResult[] {
	return results.filter((result): result is QuizResult => !!result);
}

export function answeredResultCount(
	results: Array<QuizResult | null | undefined>
): number {
	return compactQuizResults(results).length;
}

export function hasAnsweredEveryQuestion(
	questions: Question[],
	results: Array<QuizResult | null | undefined>
): boolean {
	return questions.length > 0 && questions.every((_, index) => !!results[index]);
}

export function firstUnansweredQuestionIndex(
	questions: Question[],
	results: Array<QuizResult | null | undefined>
): number {
	const index = questions.findIndex((_, questionIndex) => !results[questionIndex]);
	return index === -1
		? Math.max(0, questions.length - 1)
		: index;
}
