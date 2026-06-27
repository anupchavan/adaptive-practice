import { Question } from "../types";
import { StructuredPrompt } from "../llm/prompt";

export function limitUniqueQuestions(
	questions: Question[],
	desiredCount: number
): Question[] {
	return mergeQuestionBatches([], questions, desiredCount);
}

export function mergeQuestionBatches(
	accepted: Question[],
	candidates: Question[],
	desiredCount: number
): Question[] {
	const output: Question[] = [];
	const seen = new Set<string>();

	for (const question of [...accepted, ...candidates]) {
		if (output.length >= desiredCount) break;
		const key = questionFingerprint(question);
		if (seen.has(key)) continue;
		seen.add(key);
		output.push(question);
	}

	return output;
}

export function buildQuestionTopUpPrompt(
	basePrompt: StructuredPrompt,
	accepted: Question[],
	desiredCount: number
): StructuredPrompt {
	const remaining = Math.max(1, desiredCount - accepted.length);
	const acceptedStems = accepted
		.slice(0, desiredCount)
		.map((question, index) => `${index + 1}. ${truncateForPrompt(question.questionText, 240)}`)
		.join("\n");
	const avoidBlock = acceptedStems
		? `\nAlready accepted question stems; do not duplicate these:\n${acceptedStems}\n`
		: "\nThe previous response had no usable questions after validation.\n";

	return {
		...basePrompt,
		textPrompt: `${basePrompt.textPrompt}

## Retry correction

The previous response did not produce enough valid Adaptive Practice questions.
For this retry, generate exactly ${remaining} additional question${remaining === 1 ? "" : "s"}.
Every MCQ must have exactly 4 unique non-empty options, and "correctAnswer" must exactly equal one of those option strings.
Every question must include non-empty "questionText", "correctAnswer", "explanation", "sourceTopics", "sourceSubtopics", and "difficulty".
${avoidBlock}
Return only the JSON for the additional question${remaining === 1 ? "" : "s"}.`,
	};
}

export function buildChallengeTopUpPrompt(
	basePrompt: StructuredPrompt,
	currentQuestions: Question[],
	desiredCount: number
): StructuredPrompt {
	const needed = Math.max(2, Math.ceil(desiredCount * 0.45));
	const easyStems = currentQuestions
		.filter((question) => question.difficulty === "easy")
		.slice(0, 8)
		.map((question, index) => `${index + 1}. ${truncateForPrompt(question.questionText, 220)}`)
		.join("\n");

	return {
		...basePrompt,
		textPrompt: `${basePrompt.textPrompt}

## Challenge correction

The validated batch was too easy for flow. Generate exactly ${needed} replacement-grade questions that are medium or hard after independent review.

Requirements:
- Ask about underlying concepts, invariants, mechanisms, failure modes, proofs, traces, calculations, or transfer.
- Do not frame the note title as the concept. Avoid stems like "In the <note title> problem, what does it do?" unless the question then forces transfer.
- Each question must include concrete "sourceSubtopics" naming the section, concept, invariant, mechanism, or trap being tested.
- At least half should require two or more substantial reasoning moves, such as tracing multiple states plus explaining an invariant, deriving complexity from a failure mode, constructing a counterexample, debugging from symptoms, or comparing two implementation choices.
- Do not label direct update recall, direct complexity recall, single-iteration traces, or one-branch checks as hard.

Under-challenging stems to avoid duplicating:
${easyStems || "None listed; still avoid one-step recall."}

Return only JSON for the replacement questions.`,
	};
}

function questionFingerprint(question: Question): string {
	return normalizeForFingerprint(`${question.questionText} ${question.correctAnswer}`);
}

function normalizeForFingerprint(value: string): string {
	return value
		.toLowerCase()
		.replace(/[`*_~[\](){}#+.!?,-]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateForPrompt(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars).trimEnd()}...`;
}
