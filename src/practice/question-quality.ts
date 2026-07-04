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

	const correction = `

## Retry correction

The previous response did not produce enough valid Adaptive Practice questions.
For this retry, generate exactly ${remaining} additional question${remaining === 1 ? "" : "s"}.
Every MCQ must have exactly 4 unique non-empty options, and "correctAnswer" must exactly equal one of those option strings.
Every question must include non-empty "questionText", "correctAnswer", "explanation", "sourceTopics", "sourceSubtopics", and "difficulty".
${avoidBlock}
Return only the JSON for the additional question${remaining === 1 ? "" : "s"}.`;

	return appendCorrection(basePrompt, correction);
}

export function buildChallengeTopUpPrompt(
	basePrompt: StructuredPrompt,
	currentQuestions: Question[],
	desiredCount: number
): StructuredPrompt {
	const needed = Math.max(2, desiredCount);
	const weakStems = currentQuestions
		.filter((question) => question.difficulty !== "hard")
		.slice(0, 8)
		.map((question, index) =>
			`${index + 1}. [${question.difficulty}] ${truncateForPrompt(question.questionText, 220)}`
		)
		.join("\n");

	const correction = `

## Challenge correction

The validated batch was too easy for flow. Generate exactly ${needed} replacement-grade questions that are medium or hard after independent review.

Requirements:
- Ask about underlying concepts, invariants, mechanisms, failure modes, proofs, traces, calculations, or transfer.
- Do not frame the note title as the concept. Avoid stems like "In the <note title> problem, what does it do?" unless the question then forces transfer.
- Each question must include concrete "sourceSubtopics" naming the section, concept, invariant, mechanism, or trap being tested.
- At least half should require two or more substantial reasoning moves, such as tracing multiple states plus explaining an invariant, deriving complexity from a failure mode, constructing a counterexample, debugging from symptoms, or comparing two implementation choices.
- For high-skill source notes, prefer hard questions over medium. Do not include easy questions in this replacement batch.
- For high-skill source notes, spread replacements across multiple concrete sourceSubtopics instead of repeating one trap or section.
- Do not label direct update recall, direct complexity recall, single-iteration traces, or one-branch checks as hard.
- For notes that teach tools, commands, syntax, or procedures (in any field), do not repeat name-the-tool, option-purpose, definition, or shallow two-token comparison stems as medium. Medium/hard procedural questions must require constructing a solution with justification, predicting output or resulting state, debugging from symptoms, or reasoning across multiple conditions. For hard procedural MCQs, make every option pair the choice with its reasoning or trap; bare name/command/formula options are not hard.
- For high-skill notes, hard replacements must combine at least two reasoning moves — construct or debug under constraints, then predict the resulting output/state or explain why an attractive alternative fails — and must use genuinely different setups rather than re-skinning one scenario.

Under-challenging stems to avoid duplicating:
${weakStems || "None listed; still avoid one-step recall."}

Return only JSON for the replacement questions.`;

	return appendCorrection(basePrompt, correction);
}

/**
 * Continuation block for just-in-time flow batches: the session so far, the
 * controller's difficulty note, and every already-asked stem to avoid.
 */
export function buildFlowContinuationPrompt(
	basePrompt: StructuredPrompt,
	asked: Question[],
	flowNote: string,
	batchSize: number
): StructuredPrompt {
	const askedStems = asked
		.slice(-24)
		.map((question, index) =>
			`${index + 1}. [${question.difficulty}] ${truncateForPrompt(question.questionText, 200)}`
		)
		.join("\n");

	const correction = `

## Flow continuation

This session is already in progress and is generated in small adaptive batches.
Flow controller: ${flowNote}
Generate exactly ${batchSize} new question${batchSize === 1 ? "" : "s"} that continue the session.
- Do not repeat or lightly reword any stem below; use different setups, subtopics, and reasoning targets.
- Keep every question answerable from the provided material.

Already asked in this session:
${askedStems || "None yet."}

Return only the JSON for the new question${batchSize === 1 ? "" : "s"}.`;

	return appendCorrection(basePrompt, correction);
}

/**
 * Append a per-session correction block to a base prompt, keeping the system
 * instructions intact and routing the dynamic text into the user turn (and the
 * combined textPrompt for fallback/tests).
 */
function appendCorrection(
	basePrompt: StructuredPrompt,
	correction: string
): StructuredPrompt {
	return {
		...basePrompt,
		userPrompt: `${basePrompt.userPrompt ?? basePrompt.textPrompt}${correction}`,
		textPrompt: `${basePrompt.textPrompt}${correction}`,
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
