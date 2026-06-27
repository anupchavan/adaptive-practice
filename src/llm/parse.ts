import { Question } from "../types";
import { isIntegerLike, parseNumericAnswer } from "../practice/numeric-answer";
import { normalizeQuestionDifficulty } from "../practice/difficulty-quality";

export function parseQuestions(raw: string): Question[] {
	const cleaned = extractJsonPayload(raw);

	const parsed: unknown = JSON.parse(cleaned);
	const questions = Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed["questions"])
			? parsed["questions"]
			: isRecord(parsed) && looksLikeQuestion(parsed)
				? [parsed]
			: null;

	if (!questions) {
		throw new Error("LLM response is not a JSON question array");
	}

	return questions
		.map((rawItem: unknown, i: number) => normalizeQuestion(rawItem, i))
		.filter((question): question is Question => question !== null);
}

function normalizeQuestion(rawItem: unknown, i: number): Question | null {
	if (!isRecord(rawItem)) return null;
	const item = rawItem;
	const rawCorrectAnswer = stringValue(item["correctAnswer"], "");
	const q: Question = {
		id: stringValue(item["id"], `q${i + 1}`),
		type: validateType(item["type"]),
		questionText: stringValue(item["questionText"], "").trim(),
		correctAnswer: rawCorrectAnswer.trim(),
		explanation: stringValue(item["explanation"], "").trim(),
		sourceTopics: normalizeStringList(item["sourceTopics"]),
		sourceSubtopics: normalizeStringList(item["sourceSubtopics"]),
		difficulty: validateDifficulty(item["difficulty"]),
	};
	if (!q.questionText || !q.correctAnswer) return null;
	if (!q.explanation) q.explanation = "No explanation provided by the model.";
	if (q.type === "mcq" && Array.isArray(item["options"])) {
		const rawOptions = item["options"].map((o) => String(o));
		q.options = rawOptions
			.map(stripOptionPrefix)
			.map((option) => option.trim())
			.filter(Boolean);
		if (q.options.length !== 4 || new Set(q.options).size !== 4) return null;
		q.correctAnswer = normalizeMcqCorrectAnswer(rawCorrectAnswer, rawOptions, q.options);
		if (!q.options.includes(q.correctAnswer)) return null;
	} else if (q.type === "mcq") {
		return null;
	} else if (!isValidNumericQuestion(q)) {
		return null;
	}
	q.difficulty = normalizeQuestionDifficulty(q);
	return q;
}

function isValidNumericQuestion(question: Question): boolean {
	if (question.type !== "integer" && question.type !== "decimal") return true;
	const parsed = parseNumericAnswer(question.correctAnswer);
	if (parsed === null) return false;
	if (question.type === "integer" && !isIntegerLike(parsed)) return false;
	return true;
}

function extractJsonPayload(raw: string): string {
	const trimmed = raw.trim().replace(/^\uFEFF/, "");
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fence?.[1]) return fence[1].trim();
	return findFirstBalancedJson(trimmed) ?? trimmed;
}

function findFirstBalancedJson(input: string): string | null {
	for (let start = 0; start < input.length; start++) {
		const first = input[start];
		if (first !== "{" && first !== "[") continue;

		const stack = [first === "{" ? "}" : "]"];
		let inString = false;
		let escaped = false;
		for (let i = start + 1; i < input.length; i++) {
			const char = input[i];
			if (inString) {
				if (escaped) {
					escaped = false;
				} else if (char === "\\") {
					escaped = true;
				} else if (char === "\"") {
					inString = false;
				}
				continue;
			}
			if (char === "\"") {
				inString = true;
			} else if (char === "{") {
				stack.push("}");
			} else if (char === "[") {
				stack.push("]");
			} else if (char === stack[stack.length - 1]) {
				stack.pop();
				if (stack.length === 0) return input.slice(start, i + 1);
			}
		}
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function stripOptionPrefix(text: string): string {
	return text.trim().replace(/^[A-Da-d][).:]\s*/, "");
}

function normalizeMcqCorrectAnswer(
	rawCorrectAnswer: string,
	rawOptions: string[],
	normalizedOptions: string[]
): string {
	const letter = optionLetter(rawCorrectAnswer);
	if (letter) {
		const labeledIndex = rawOptions.findIndex((option, index) =>
			optionLetter(option) === letter || String.fromCharCode(65 + index) === letter
		);
		if (labeledIndex >= 0) return normalizedOptions[labeledIndex] ?? stripOptionPrefix(rawCorrectAnswer);
	}

	const normalizedAnswer = stripOptionPrefix(rawCorrectAnswer);
	const exact = normalizedOptions.find((option) => option === normalizedAnswer);
	return exact ?? normalizedAnswer;
}

function optionLetter(value: string): string | null {
	const trimmed = value.trim();
	const match = /^(?:option\s*)?([A-Da-d])(?:[).:]|\s*$)/i.exec(trimmed);
	return match?.[1]?.toUpperCase() ?? null;
}

function stringValue(value: unknown, fallback: string): string {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return String(value);
	}
	return fallback;
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const normalized: string[] = [];
	for (const item of value) {
		const trimmed = String(item).trim();
		if (trimmed && !normalized.includes(trimmed)) normalized.push(trimmed);
	}
	return normalized;
}

function validateType(v: unknown): Question["type"] {
	if (v === "mcq" || v === "integer" || v === "decimal") return v;
	return "mcq";
}

function validateDifficulty(v: unknown): Question["difficulty"] {
	if (v === "easy" || v === "medium" || v === "hard") return v;
	return "medium";
}

function looksLikeQuestion(value: Record<string, unknown>): boolean {
	return (
		"questionText" in value ||
		"correctAnswer" in value ||
		"explanation" in value
	);
}
