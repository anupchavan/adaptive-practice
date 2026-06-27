import { DailyChallengeMode, Difficulty, Question, TopicNote } from "../types";

export function shouldRequestChallengeTopUp(
	questions: Question[],
	topics: TopicNote[],
	mode: DailyChallengeMode = "steady"
): boolean {
	if (mode === "warmup" || questions.length < 4) return false;
	const counts = countDifficulties(questions);
	const desired = desiredDifficultyCounts(
		questions.length,
		averageSkill(topics),
		mode
	);
	const mediumPlus = counts.medium + counts.hard;
	const desiredMediumPlus = desired.medium + desired.hard;
	return (
		counts.easy > desired.easy + 1 ||
		mediumPlus < Math.max(2, desiredMediumPlus - 1) ||
		(mode === "stretch" && counts.hard < Math.max(1, desired.hard - 1))
	);
}

export function selectFlowBalancedQuestions(
	existing: Question[],
	candidates: Question[],
	desiredCount: number,
	topics: TopicNote[],
	mode: DailyChallengeMode = "steady"
): Question[] {
	const all = uniqueByStem([...existing, ...candidates]);
	if (all.length <= desiredCount) return sequenceForFlow(all);

	const desired = desiredDifficultyCounts(desiredCount, averageSkill(topics), mode);
	const buckets: Record<Difficulty, Question[]> = {
		easy: [],
		medium: [],
		hard: [],
	};
	for (const question of all) {
		buckets[question.difficulty].push(question);
	}

	const selected: Question[] = [];
	take(selected, buckets.hard, desired.hard);
	take(selected, buckets.medium, desired.medium);
	take(selected, buckets.easy, desired.easy);

	const leftovers = uniqueByStem([
		...buckets.hard,
		...buckets.medium,
		...buckets.easy,
	]).filter((question) => !selected.includes(question));
	take(selected, leftovers, desiredCount - selected.length);

	return sequenceForFlow(selected.slice(0, desiredCount));
}

export function desiredDifficultyCounts(
	count: number,
	averageSkillValue: number,
	mode: DailyChallengeMode = "steady"
): Record<Difficulty, number> {
	const skill = Number.isFinite(averageSkillValue) ? averageSkillValue : 50;
	let ratios: Record<Difficulty, number>;
	if (mode === "warmup") {
		ratios = { easy: 0.55, medium: 0.4, hard: 0.05 };
	} else if (mode === "stretch") {
		ratios = { easy: 0.05, medium: 0.4, hard: 0.55 };
	} else if (skill <= 30) {
		ratios = { easy: 0.6, medium: 0.3, hard: 0.1 };
	} else if (skill <= 60) {
		ratios = { easy: 0.3, medium: 0.45, hard: 0.25 };
	} else if (skill <= 80) {
		ratios = { easy: 0.1, medium: 0.4, hard: 0.5 };
	} else {
		ratios = { easy: 0, medium: 0.25, hard: 0.75 };
	}

	const easy = Math.round(count * ratios.easy);
	const hard = Math.round(count * ratios.hard);
	const medium = Math.max(0, count - easy - hard);
	return { easy, medium, hard };
}

function countDifficulties(questions: Question[]): Record<Difficulty, number> {
	return {
		easy: questions.filter((question) => question.difficulty === "easy").length,
		medium: questions.filter((question) => question.difficulty === "medium").length,
		hard: questions.filter((question) => question.difficulty === "hard").length,
	};
}

function sequenceForFlow(questions: Question[]): Question[] {
	const buckets: Record<Difficulty, Question[]> = {
		easy: [],
		medium: [],
		hard: [],
	};
	for (const question of questions) {
		buckets[question.difficulty].push(question);
	}

	const out: Question[] = [];
	takeFirstAvailable(out, buckets, ["easy", "medium", "hard"]);

	while (hasRemaining(buckets)) {
		const last = out[out.length - 1]?.difficulty;
		const preferences = nextDifficultyPreferences(last);
		const recent = out.slice(-2).map((question) => question.difficulty);
		const avoid =
			recent.length === 2 && recent[0] === recent[1]
				? recent[0]
				: null;
		const preferred = avoid
			? preferences.filter((difficulty) => difficulty !== avoid)
			: preferences;
		if (!takeFirstAvailable(out, buckets, preferred)) {
			takeFirstAvailable(out, buckets, preferences);
		}
	}

	return out;
}

function nextDifficultyPreferences(last: Difficulty | undefined): Difficulty[] {
	if (last === "easy") return ["medium", "hard", "easy"];
	if (last === "medium") return ["hard", "medium", "easy"];
	if (last === "hard") return ["medium", "easy", "hard"];
	return ["easy", "medium", "hard"];
}

function takeFirstAvailable(
	out: Question[],
	buckets: Record<Difficulty, Question[]>,
	preferences: Difficulty[]
): boolean {
	for (const difficulty of preferences) {
		const next = buckets[difficulty].shift();
		if (!next) continue;
		out.push(next);
		return true;
	}
	return false;
}

function hasRemaining(buckets: Record<Difficulty, Question[]>): boolean {
	return buckets.easy.length + buckets.medium.length + buckets.hard.length > 0;
}

function uniqueByStem(questions: Question[]): Question[] {
	const out: Question[] = [];
	const seen = new Set<string>();
	for (const question of questions) {
		const key = normalize(`${question.questionText} ${question.correctAnswer}`);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(question);
	}
	return out;
}

function take<T>(out: T[], source: T[], count: number): void {
	while (count > 0 && source.length > 0) {
		const item = source.shift();
		if (item) out.push(item);
		count--;
	}
}

function averageSkill(topics: TopicNote[]): number {
	if (topics.length === 0) return 50;
	return topics.reduce((sum, topic) => sum + topic.skill, 0) / topics.length;
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
