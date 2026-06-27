import { PracticeMemory, QuizResult } from "../types";
import { hasPracticedToday } from "./daily-status";
import { evaluatePracticeSessionMeaningfulness } from "./scheduler";

export type PracticeCreditStatus = "counted" | "already-counted" | "not-counted";

export interface PracticeCredit {
	status: PracticeCreditStatus;
	title: string;
	detail: string;
}

export function resolvePracticeCredit(
	before: PracticeMemory | undefined,
	after: PracticeMemory | undefined,
	now = new Date(),
	results: QuizResult[] = []
): PracticeCredit {
	if (hasPracticedToday(before, now)) {
		return {
			status: "already-counted",
			title: "Streak already counted today",
			detail: "Extra practice was saved without adding another streak day.",
		};
	}
	if (hasPracticedToday(after, now)) {
		return {
			status: "counted",
			title: "Daily streak counted",
			detail: "This session had enough deliberate answers to count for today.",
		};
	}
	return {
		status: "not-counted",
		title: "Streak not counted",
		detail: results.length > 0
			? evaluatePracticeSessionMeaningfulness(results).detail
			: "Too many skips or very fast answers do not count toward the daily streak.",
	};
}
