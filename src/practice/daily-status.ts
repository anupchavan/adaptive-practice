import { PracticeMemory } from "../types";
import { localDateKey, normalizePracticeMemory } from "./scheduler";

export function hasPracticedToday(
	memory: PracticeMemory | undefined,
	now = new Date()
): boolean {
	const normalized = normalizePracticeMemory(memory);
	return normalized.daily.lastPracticeDate === localDateKey(now);
}
