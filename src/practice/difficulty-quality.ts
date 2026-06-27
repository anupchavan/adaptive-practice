import { Difficulty, Question } from "../types";

type QuestionDifficultyInput = Pick<
	Question,
	"questionText" | "correctAnswer" | "explanation" | "sourceTopics" | "sourceSubtopics" | "difficulty" | "options" | "type"
>;

export interface DifficultyEstimate {
	difficulty: Difficulty;
	score: number;
	reasons: string[];
}

export function normalizeQuestionDifficulty(
	question: QuestionDifficultyInput
): Difficulty {
	return estimateQuestionDifficulty(question).difficulty;
}

export function estimateQuestionDifficulty(
	question: QuestionDifficultyInput
): DifficultyEstimate {
	const questionText = question.questionText.trim();
	const lowerQuestion = questionText.toLowerCase();
	const combined = [
		questionText,
		question.correctAnswer,
		question.explanation,
		...(question.options ?? []),
		...question.sourceTopics,
		...(question.sourceSubtopics ?? []),
	]
		.join("\n")
		.toLowerCase();

	const hasCodeOrTrace = /```|~~~|`[^`]+`|\b(trace|dry run|simulate|step through|iteration|pseudocode|loop invariant)\b/.test(combined);
	const hasProofOrFailureMode = /\b(prove|proof|counterexample|contradiction|invariant|edge case|corner case|boundary|fails?|failure|invalid|violat(?:e|es|ing)|breaks?|limiting case)\b/.test(combined);
	const hasComplexityAnalysis = /\b(worst[- ]case|best[- ]case|average[- ]case|complexity|asymptotic|amortized|big[- ]?o|logarithmic|linear scan|recurrence|theta|omega)\b|[o]\s*\(/i.test(combined);
	const hasComparisonOrTradeoff = /\b(compare|contrast|differs?|unlike|versus|vs\.?|trade[- ]?off|implementation|method choice|choose the method)\b/.test(combined);
	const hasModelingOrDerivation = /\b(derive|deduce|model|assumption|frame|relative motion|sign convention|unit|dimension|mechanism|compete|rate law|equilibrium|stereochemistry|row operation)\b/.test(combined);
	const hasTransferTrap = /\b(new setting|variant|modified|duplicate|trap|subtle|symptom|debug|off[- ]by[- ]one|hidden condition|not enough|ambiguous)\b/.test(combined);
	const hasWhyOrExplain = /\bwhy\b|\bexplain\b|\bwhat happens next\b|\bunder what condition\b/.test(combined);
	const hasConcreteExample = /(?:\[[^\]]+\]|\bnums\s*=|\barr\s*=|\btarget\s*=|\bk\s*=|\$\s*[-+]?\d)/i.test(questionText);
	const conditionCount = countMatches(lowerQuestion, /\b(if|when|given|consider|suppose|after|under|unless|while)\b/g);
	const hasMultiCondition = conditionCount >= 2 || questionText.length >= 210;
	const sourceSubtopicCount = question.sourceSubtopics?.length ?? 0;
	const titleFramed = hasTitleFraming(question);
	const directOneStep = isDirectOneStepQuestion(lowerQuestion);

	let score = 0;
	const reasons: string[] = [];
	const add = (amount: number, reason: string): void => {
		score += amount;
		reasons.push(reason);
	};

	if (hasCodeOrTrace) add(1.1, "code-or-trace");
	if (hasProofOrFailureMode) add(1.4, "proof-or-failure-mode");
	if (hasComplexityAnalysis) add(1.8, "complexity");
	if (hasComparisonOrTradeoff) add(1.1, "comparison");
	if (hasModelingOrDerivation) add(1.2, "modeling-or-derivation");
	if (hasTransferTrap) add(1.4, "transfer-trap");
	if (hasWhyOrExplain) add(0.7, "asks-why");
	if (hasMultiCondition) add(1, "multi-condition");
	if (question.type === "integer" || question.type === "decimal") {
		add(0.7, "constructed-answer");
	}
	if (sourceSubtopicCount >= 2) add(0.6, "multi-subtopic");
	if (questionText.length >= 280) add(0.6, "long-stem");

	if (directOneStep) {
		score -= 2.2;
		reasons.push("direct-one-step");
	}
	if (titleFramed && sourceSubtopicCount === 0) {
		score -= 1;
		reasons.push("title-framed-without-concept");
	}
	if (hasConcreteExample && !hasComplexityAnalysis && !hasProofOrFailureMode && !hasTransferTrap && conditionCount <= 1) {
		score -= 0.8;
		reasons.push("single-concrete-case");
	}

	const reasoningCategories = [
		hasCodeOrTrace,
		hasProofOrFailureMode,
		hasComplexityAnalysis,
		hasComparisonOrTradeoff,
		hasModelingOrDerivation,
		hasTransferTrap,
	].filter(Boolean).length;

	if (
		score >= 5 &&
		reasoningCategories >= 2 &&
		(hasMultiCondition || hasWhyOrExplain || hasComplexityAnalysis || hasProofOrFailureMode)
	) {
		return { difficulty: "hard", score, reasons };
	}
	if (score >= 2.8 && !directOneStep) {
		return { difficulty: "medium", score, reasons };
	}
	if (score >= 3.4) {
		return { difficulty: "medium", score, reasons };
	}
	return { difficulty: "easy", score, reasons };
}

export function isGenuinelyHardQuestion(question: QuestionDifficultyInput): boolean {
	return estimateQuestionDifficulty(question).difficulty === "hard";
}

function countMatches(value: string, pattern: RegExp): number {
	return [...value.matchAll(pattern)].length;
}

function isDirectOneStepQuestion(lowerQuestion: string): boolean {
	return /\b(what does it do|what is the returned|what is returned|which element is recorded|which half is eliminated|which half|who introduced|who discovered|which option|what is the name|which statement is true|select the correct)\b/.test(lowerQuestion) ||
		/\bwhen\b.+\bwhat does\b/.test(lowerQuestion) ||
		/\bafter\b.+\bwhat is the returned\b/.test(lowerQuestion);
}

function hasTitleFraming(question: QuestionDifficultyInput): boolean {
	const normalizedQuestion = normalizeText(question.questionText);
	return question.sourceTopics.some((topic) => {
		const normalizedTopic = normalizeText(topic);
		return normalizedTopic.length >= 8 && normalizedQuestion.includes(normalizedTopic);
	});
}

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
