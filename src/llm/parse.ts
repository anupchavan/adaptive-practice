import { Question } from "../types";
import { isIntegerLike, parseNumericAnswer } from "../practice/numeric-answer";
import { normalizeQuestionDifficulty } from "../practice/difficulty-quality";
import { normalizeQuestionFormatting } from "./format-normalize";

export function parseQuestions(raw: string): Question[] {
	const parsed = parseQuestionPayload(raw);
	const questions = extractQuestionItems(parsed);

	if (!questions) {
		throw new Error("LLM response is not a JSON question array");
	}

	return questions
		.map((rawItem: unknown, i: number) => normalizeQuestion(rawItem, i))
		.filter((question): question is Question => question !== null);
}

function parseQuestionPayload(raw: string): unknown {
	const candidates = extractJsonCandidates(raw);
	let parsedNonQuestionPayload = false;
	let firstSyntaxError = "";

	for (const candidate of candidates) {
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (extractQuestionItems(parsed)) return parsed;
			parsedNonQuestionPayload = true;
		} catch (e) {
			if (!firstSyntaxError && e instanceof Error) {
				firstSyntaxError = e.message;
			}
		}
	}

	if (parsedNonQuestionPayload) {
		throw new Error("LLM response is not a JSON question array");
	}

	throw new SyntaxError(
		`LLM response did not contain valid JSON questions${
			firstSyntaxError ? `: ${firstSyntaxError}` : ""
		}`
	);
}

function extractQuestionItems(parsed: unknown): unknown[] | null {
	return Array.isArray(parsed)
		? parsed
		: isRecord(parsed) && Array.isArray(parsed["questions"])
			? parsed["questions"]
			: isRecord(parsed) && looksLikeQuestion(parsed)
				? [parsed]
				: null;
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
		q.options = shuffleMcqOptions(q.options, q.correctAnswer, [
			q.id,
			q.questionText,
			q.correctAnswer,
		].join("\n"));
	} else if (q.type === "mcq") {
		return null;
	} else if (!isValidNumericQuestion(q)) {
		return null;
	}
	// Apply provider-agnostic formatting repairs (math delimiters, etc.) before
	// difficulty estimation so the heuristic sees the same text the learner will.
	const formatted = normalizeQuestionFormatting(q);
	formatted.difficulty = normalizeQuestionDifficulty(formatted);
	return formatted;
}

function isValidNumericQuestion(question: Question): boolean {
	if (question.type !== "integer" && question.type !== "decimal") return true;
	const parsed = parseNumericAnswer(question.correctAnswer);
	if (parsed === null) return false;
	if (question.type === "integer" && !isIntegerLike(parsed)) return false;
	return true;
}

function extractJsonCandidates(raw: string): string[] {
	const trimmed = raw.trim().replace(/^\uFEFF/, "");
	const candidates: string[] = [];
	const seen = new Set<string>();

	const addCandidate = (candidate: string): void => {
		const normalized = candidate.trim().replace(/^\uFEFF/, "");
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		candidates.push(normalized);
	};

	if (startsJson(trimmed)) addCandidate(trimmed);

	const fencePattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
	let fence: RegExpExecArray | null;
	while ((fence = fencePattern.exec(trimmed)) !== null) {
		const language = (fence[1] ?? "").trim().toLowerCase();
		const body = (fence[2] ?? "").trim();
		if (!body) continue;

		const isJsonFence = language === "json" || language === "jsonc";
		if (!isJsonFence && language && !startsJson(body)) continue;

		for (const candidate of findBalancedJsonCandidates(body)) {
			addCandidate(candidate);
		}
		if (startsJson(body)) addCandidate(body);
	}

	for (const candidate of findBalancedJsonCandidates(trimmed)) {
		addCandidate(candidate);
	}

	if (candidates.length === 0) addCandidate(trimmed);
	return candidates;
}

function startsJson(input: string): boolean {
	const first = input.trimStart()[0];
	return first === "{" || first === "[";
}

function findBalancedJsonCandidates(input: string): string[] {
	const candidates: string[] = [];
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
				if (stack.length === 0) {
					candidates.push(input.slice(start, i + 1));
					break;
				}
			}
		}
	}
	return candidates;
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

function shuffleMcqOptions(
	options: string[],
	correctAnswer: string,
	seedText: string
): string[] {
	const terminalOptions = options.filter(isTerminalOption);
	const regularOptions = options.filter((option) => !isTerminalOption(option));
	if (regularOptions.length <= 1) return [...regularOptions, ...terminalOptions];

	const originalCorrectIndex = regularOptions.indexOf(correctAnswer);
	const shuffled = [...regularOptions];
	let seed = hashString(seedText);
	for (let i = shuffled.length - 1; i > 0; i--) {
		seed = nextSeed(seed);
		const j = seed % (i + 1);
		[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
	}

	if (originalCorrectIndex >= 0 && shuffled.indexOf(correctAnswer) === originalCorrectIndex) {
		const offset = (hashString(`${seedText}\ncorrect-offset`) % (shuffled.length - 1)) + 1;
		shuffled.push(...shuffled.splice(0, offset));
	}

	return [...shuffled, ...terminalOptions];
}

function isTerminalOption(option: string): boolean {
	return /^(?:all|none)\s+of\s+(?:the\s+)?(?:above|these|the\s+options)\b/i
		.test(option.trim());
}

function hashString(value: string): number {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function nextSeed(seed: number): number {
	return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
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
