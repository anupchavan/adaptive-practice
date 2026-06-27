import {
	DailyChallengeMode,
	PracticeDraft,
	Question,
	QuestionType,
	QuizResult,
	SessionConfig,
	TopicNote,
} from "../types";

const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizePracticeDraft(
	input: unknown,
	now = Date.now()
): PracticeDraft | null {
	if (!isRecord(input)) return null;
	const questions = normalizeQuestions(input["questions"]);
	const topics = normalizeTopics(input["topics"]);
	if (questions.length === 0 || topics.length === 0) return null;

	const results = normalizeResults(input["results"], questions);
	const maxIndex = Math.max(0, questions.length - 1);
	const firstUnanswered = firstUnansweredIndex(questions, results);
	const currentIndex = clampNumber(
		input["currentIndex"],
		0,
		maxIndex,
		Math.min(firstUnanswered, maxIndex)
	);
	const createdAt = clampNumber(input["createdAt"], 0, now, now);
	const updatedAt = clampNumber(input["updatedAt"], 0, now, createdAt);
	if (now - updatedAt > MAX_DRAFT_AGE_MS) return null;
	if (results.length >= questions.length) return null;

	const config = normalizeSessionConfig(input["config"], topics, questions.length);

	return {
		questions,
		results,
		currentIndex,
		topics,
		config,
		createdAt,
		updatedAt,
	};
}

export function buildPracticeDraft(
	questions: Question[],
	results: QuizResult[],
	currentIndex: number,
	topics: TopicNote[],
	config: SessionConfig,
	now = Date.now()
): PracticeDraft {
	return normalizePracticeDraft({
		questions,
		results,
		currentIndex,
		topics,
		config,
		createdAt: now,
		updatedAt: now,
	}, now) ?? {
		questions,
		results,
		currentIndex: Math.min(Math.max(0, currentIndex), Math.max(0, questions.length - 1)),
		topics,
		config,
		createdAt: now,
		updatedAt: now,
	};
}

export function practiceDraftProgress(draft: PracticeDraft): string {
	const answered = draft.results.length;
	const total = draft.questions.length;
	return `${answered} / ${total} answered`;
}

export function shouldConfirmPracticeDraftReplacement(
	draft: PracticeDraft | null | undefined,
	replaceDraft: boolean
): boolean {
	return !replaceDraft && !!normalizePracticeDraft(draft);
}

function normalizeQuestions(input: unknown): Question[] {
	if (!Array.isArray(input)) return [];
	return input
		.map(normalizeQuestion)
		.filter((question): question is Question => !!question);
}

function normalizeQuestion(input: unknown): Question | null {
	if (!isRecord(input)) return null;
	const type = normalizeQuestionType(input["type"]);
	const questionText = stringValue(input["questionText"]).trim();
	const correctAnswer = stringValue(input["correctAnswer"]).trim();
	const explanation = stringValue(input["explanation"]).trim();
	const difficulty = input["difficulty"];
	if (!questionText || !correctAnswer) return null;
	if (difficulty !== "easy" && difficulty !== "medium" && difficulty !== "hard") {
		return null;
	}
	const question: Question = {
		id: stringValue(input["id"]).trim() || stableFallbackId(questionText),
		type,
		questionText,
		correctAnswer,
		explanation: explanation || "No explanation provided.",
		sourceTopics: normalizeStringList(input["sourceTopics"]),
		sourceSubtopics: normalizeStringList(input["sourceSubtopics"]),
		difficulty,
	};
	if (type === "mcq") {
		const options = normalizeStringList(input["options"]);
		if (options.length !== 4) return null;
		question.options = options;
	}
	return question;
}

function normalizeResults(input: unknown, questions: Question[]): QuizResult[] {
	if (!Array.isArray(input)) return [];
	const byId = new Map(questions.map((question) => [question.id, question]));
	const results: QuizResult[] = [];
	for (const item of input) {
		if (!isRecord(item)) continue;
		const rawQuestion = normalizeQuestion(item["question"]);
		const question = rawQuestion ? byId.get(rawQuestion.id) ?? rawQuestion : null;
		if (!question) continue;
		results.push({
			question,
			userAnswer: stringValue(item["userAnswer"]),
			isCorrect: Boolean(item["isCorrect"]),
			skipped: Boolean(item["skipped"]),
			timeTakenMs: clampNumber(item["timeTakenMs"], 0, Number.MAX_SAFE_INTEGER, 0),
		});
	}
	return results.slice(0, questions.length);
}

function normalizeTopics(input: unknown): TopicNote[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item): TopicNote | null => {
			if (!isRecord(item)) return null;
			const path = stringValue(item["path"]).trim();
			const title = stringValue(item["title"]).trim();
			if (!path || !title) return null;
			return {
				path,
				title,
				skill: clampNumber(item["skill"], 0, 100, 50),
				isPdf: Boolean(item["isPdf"]),
				createdAt: optionalNumber(item["createdAt"]),
				updatedAt: optionalNumber(item["updatedAt"]),
				lastPracticedAt: optionalNumber(item["lastPracticedAt"]),
				dueAt: optionalNumber(item["dueAt"]),
				priorityScore: optionalNumber(item["priorityScore"]),
				scheduleReason: stringValue(item["scheduleReason"]) || undefined,
			};
		})
		.filter((topic): topic is TopicNote => !!topic);
}

function normalizeSessionConfig(
	input: unknown,
	topics: TopicNote[],
	questionCount: number
): SessionConfig {
	const raw = isRecord(input) ? input : {};
	const mode = raw["mode"] === "daily" ? "daily" : "manual";
	const challengeMode = normalizeChallengeMode(raw["challengeMode"]);
	const challengeReason = stringValue(raw["challengeReason"]).trim();
	return {
		topics,
		questionCount: clampNumber(raw["questionCount"], 1, 100, questionCount),
		mode,
		challengeMode,
		challengeReason,
	};
}

function firstUnansweredIndex(questions: Question[], results: QuizResult[]): number {
	return Math.min(results.length, Math.max(0, questions.length - 1));
}

function normalizeQuestionType(value: unknown): QuestionType {
	return value === "integer" || value === "decimal" ? value : "mcq";
}

function normalizeChallengeMode(value: unknown): DailyChallengeMode {
	if (value === "warmup" || value === "stretch") return value;
	return "steady";
}

function normalizeStringList(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const out: string[] = [];
	for (const item of input) {
		const value = stringValue(item).trim();
		if (value && !out.includes(value)) out.push(value);
	}
	return out;
}

function optionalNumber(input: unknown): number | undefined {
	if (typeof input !== "number" || !Number.isFinite(input)) return undefined;
	return input;
}

function clampNumber(
	input: unknown,
	min: number,
	max: number,
	fallback: number
): number {
	if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
	return Math.min(max, Math.max(min, input));
}

function stringValue(input: unknown): string {
	if (
		typeof input === "string" ||
		typeof input === "number" ||
		typeof input === "boolean"
	) {
		return String(input);
	}
	return "";
}

function stableFallbackId(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "question";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}
