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
- For Linux/shell notes, do not repeat direct command-purpose, option-purpose, pipe-definition, signal-name, simple permission-decoding, shallow command comparisons, or command-choice stems as medium. Medium/hard shell questions must require command construction with justification, output/state prediction, debugging, quoting/redirection reasoning, or multi-condition state reasoning. For hard shell MCQs, make every option include the command plus a reason/trap; bare command-line options are not hard.
- For high-skill Linux/shell notes, spread replacements across different shell mechanics such as expansion/quoting, searching with find/grep/xargs, permissions, streams/redirection, pipes/filters, processes/signals, and filesystem links.
- For 90+ Linux/shell notes, hard replacements must combine at least two shell reasoning moves: construct or debug a command under constraints, then predict stdout/stderr/file/process state or explain why an attractive command fails.

Under-challenging stems to avoid duplicating:
${weakStems || "None listed; still avoid one-step recall."}

Return only JSON for the replacement questions.`;

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
