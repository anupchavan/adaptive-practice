import { Difficulty, Question, QuizResult, SkillDelta, TopicNote } from "../types";
import { reconcileSourceTopics } from "./source-map";
import { isIntegerLike, parseNumericAnswer } from "./numeric-answer";

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

	const correctNum = parseNumericAnswer(question.correctAnswer);
	const givenNum = parseNumericAnswer(userAnswer);
	if (correctNum === null || givenNum === null) return false;

	if (question.type === "integer") {
		return isIntegerLike(correctNum) &&
			isIntegerLike(givenNum) &&
			Math.abs(correctNum - givenNum) < 1e-9;
	}

	// decimal: allow 1% relative tolerance or 0.01 absolute
	const absDiff = Math.abs(correctNum - givenNum);
	return absDiff <= 0.01 || absDiff <= Math.abs(correctNum) * 0.01;
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
	if (results.length === 0) return 0;
	const total = results.reduce((sum, result) => sum + resultFluency(result), 0);
	return total / results.length;
}

export function computeSkillDeltas(
	topics: TopicNote[],
	results: QuizResult[]
): SkillDelta[] {
	const skillMap = new Map<string, { note: TopicNote; skill: number }>();
	for (const t of topics) {
		skillMap.set(t.title, { note: t, skill: t.skill });
	}

	for (const r of results) {
		const mult = DIFFICULTY_MULTIPLIER[r.question.difficulty];
		for (const topicTitle of reconcileSourceTopics(r.question.sourceTopics, topics)) {
			const entry = skillMap.get(topicTitle);
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

	return topics.map((t) => {
		const entry = skillMap.get(t.title);
		return {
			path: t.path,
			title: t.title,
			before: t.skill,
			after: entry ? entry.skill : t.skill,
		};
	});
}
