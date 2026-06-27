import { PracticeMemory } from "../types";
import { hasPracticedToday } from "./daily-status";

export type PracticeCreditStatus = "counted" | "already-counted" | "not-counted";

export interface PracticeCredit {
	status: PracticeCreditStatus;
	title: string;
	detail: string;
}

export function resolvePracticeCredit(
	before: PracticeMemory | undefined,
	after: PracticeMemory | undefined,
	now = new Date()
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
		detail: "Too many skips or very fast answers do not count toward the daily streak.",
	};
}
