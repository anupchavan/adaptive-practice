import { Difficulty, Question, QuizResult, SkillDelta, TopicNote } from "../types";
import { reconcileSourceTopics } from "./source-map";
import { isIntegerLike, parseNumericAnswer } from "./numeric-answer";
import { compactQuizResults } from "./results";

const DIFFICULTY_MULTIPLIER: Record<Difficulty, number> = {
	easy: 0.5,
	medium: 1.0,
	hard: 1.5,
};

const EXPECTED_TIME_MS: Record<Difficulty, number> = {
	easy: 45_000,
	medium: 90_000,
	hard: 150_000,
};

export function checkAnswer(question: Question, userAnswer: string): boolean {
	const correct = normalizeTextAnswer(question.correctAnswer);
	const given = normalizeTextAnswer(userAnswer);

	if (question.type === "mcq") {
		return correct === given;
	}

	if (question.type === "multi") {
		// All-or-nothing set equality over the newline-joined selections;
		// order never matters.
		const correctSet = new Set(
			multiCorrectAnswers(question).map(normalizeTextAnswer).filter(Boolean)
		);
		const givenSet = new Set(
			userAnswer.split("\n").map(normalizeTextAnswer).filter(Boolean)
		);
		if (correctSet.size === 0 || givenSet.size !== correctSet.size) return false;
		for (const entry of correctSet) {
			if (!givenSet.has(entry)) return false;
		}
		return true;
	}

	const correctNum = parseNumericAnswer(question.correctAnswer);
	const givenNum = parseNumericAnswer(userAnswer);
	if (correctNum === null || givenNum === null) return false;

	// Only enforce exact integer equality when the model's correct answer is
	// genuinely an integer. If a non-integer answer was mislabeled "integer"
	// (a common model mistake), fall through to tolerant numeric comparison
	// instead of marking every attempt wrong.
	if (question.type === "integer" && isIntegerLike(correctNum)) {
		return isIntegerLike(givenNum) && Math.abs(correctNum - givenNum) < 1e-9;
	}

	// decimal (and mislabeled-integer) answers: allow 1% relative tolerance or 0.01 absolute
	const absDiff = Math.abs(correctNum - givenNum);
	return absDiff <= 0.01 || absDiff <= Math.abs(correctNum) * 0.01;
}

/** The correct options of a multi question, tolerating older saved drafts. */
export function multiCorrectAnswers(question: Question): string[] {
	if (question.correctAnswers && question.correctAnswers.length > 0) {
		return question.correctAnswers;
	}
	return question.correctAnswer.split("\n").filter(Boolean);
}

function normalizeTextAnswer(input: string): string {
	return stripOptionPrefix(input)
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function stripOptionPrefix(text: string): string {
	return text.trim().replace(/^[A-Da-d][).]\s*/, "");
}

export function expectedTimeMs(question: Question): number {
	const base = EXPECTED_TIME_MS[question.difficulty];
	if (question.type === "integer" || question.type === "decimal") return base * 1.2;
	return base;
}

export function resultFluency(result: QuizResult): number {
	if (result.skipped) return 0;
	const expected = expectedTimeMs(result.question);
	const ratio = result.timeTakenMs / expected;
	const pace = ratio <= 0.6 ? 1 : ratio <= 1 ? 0.85 : ratio <= 1.6 ? 0.6 : 0.35;
	return result.isCorrect ? pace : Math.max(0.1, 1 - pace);
}

export function averageFluency(results: QuizResult[]): number {
	const answered = compactQuizResults(results);
	if (answered.length === 0) return 0;
	const total = answered.reduce((sum, result) => sum + resultFluency(result), 0);
	return total / answered.length;
}

export function computeSkillDeltas(
	topics: TopicNote[],
	results: QuizResult[]
): SkillDelta[] {
	// Key skill state by path, not title: titles are not unique in Obsidian, so a
	// title-keyed map would cross-apply deltas between two distinct same-titled notes.
	const skillByPath = new Map<string, { note: TopicNote; skill: number }>();
	const titleToPaths = new Map<string, string[]>();
	for (const t of topics) {
		skillByPath.set(t.path, { note: t, skill: t.skill });
		const paths = titleToPaths.get(t.title) ?? [];
		paths.push(t.path);
		titleToPaths.set(t.title, paths);
	}

	for (const r of compactQuizResults(results)) {
		const mult = DIFFICULTY_MULTIPLIER[r.question.difficulty];
		for (const topicTitle of reconcileSourceTopics(r.question.sourceTopics, topics)) {
			for (const path of titleToPaths.get(topicTitle) ?? []) {
				const entry = skillByPath.get(path);
				if (!entry) continue;

				const fluency = resultFluency(r);
				if (r.isCorrect) {
					entry.skill = Math.min(
						100,
						entry.skill + (100 - entry.skill) * 0.08 * mult * (0.65 + fluency * 0.5)
					);
				} else {
					const penalty = r.skipped ? 0.075 : 0.05;
					entry.skill = Math.max(
						0,
						entry.skill - entry.skill * penalty * mult * (1.15 - fluency * 0.25)
					);
				}
			}
		}
	}

	return topics.map((t) => {
		const entry = skillByPath.get(t.path);
		return {
			path: t.path,
			title: t.title,
			before: t.skill,
			after: entry ? entry.skill : t.skill,
		};
	});
}
