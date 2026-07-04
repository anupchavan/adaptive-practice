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
	const procedural = analyzeProceduralReasoning(combined, lowerQuestion);
	const toolChoiceOnly = isToolChoiceOnlyQuestion(
		lowerQuestion,
		question.options?.length ?? 0
	);
	const bareOptionSpotting = isBareTechnicalOptionChoice(
		question.options ?? [],
		question.correctAnswer
	);
	const simplePrediction = isSingleStepPredictionQuestion(lowerQuestion);
	const conditionCount = countMatches(lowerQuestion, /\b(if|when|given|consider|suppose|after|under|unless|while)\b/g);
	const hasMultiCondition = conditionCount >= 2 || questionText.length >= 210;
	const sourceSubtopicCount = question.sourceSubtopics?.length ?? 0;
	const titleFramed = hasTitleFraming(question);
	const directOneStep =
		isDirectOneStepQuestion(lowerQuestion) ||
		procedural.hasShallowRecall ||
		toolChoiceOnly;

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
	if (procedural.hasComposition) add(1.4, "procedural-composition");
	if (procedural.hasMultiConstraint) add(1.2, "procedural-multi-constraint");
	if (procedural.hasOutputOrStateReasoning) add(0.9, "output-or-state");
	if (procedural.hasOrderSensitivity) add(1.6, "order-sensitivity");
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
	if (procedural.hasShallowRecall) {
		score -= 0.8;
		reasons.push("shallow-tool-recall");
	}
	if (toolChoiceOnly) {
		score -= 0.6;
		reasons.push("tool-choice-only");
	}
	if (bareOptionSpotting) {
		score -= 1.2;
		reasons.push("bare-option-spotting");
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
		procedural.hasHardReasoning,
	].filter(Boolean).length;
	const substantialReasoningMoves = [
		hasMultiStepTrace(combined),
		hasFailureModeReasoning(combined),
		hasComplexityReasoning(combined),
		hasComparisonOrTradeoff,
		hasModelingOrDerivation,
		hasTransferReasoning(combined),
		procedural.hasSubstantialReasoning,
	].filter(Boolean).length;

	if (
		!directOneStep &&
		!toolChoiceOnly &&
		!bareOptionSpotting &&
		!simplePrediction &&
		score >= 5 &&
		reasoningCategories >= 2 &&
		substantialReasoningMoves >= 2 &&
		(hasMultiCondition ||
			hasWhyOrExplain ||
			hasComplexityAnalysis ||
			hasProofOrFailureMode ||
			procedural.hasMultiConstraint)
	) {
		return { difficulty: "hard", score, reasons };
	}
	if (toolChoiceOnly) {
		return { difficulty: "easy", score, reasons };
	}
	if (bareOptionSpotting) {
		// Spotting the right bare token caps at medium — and only earns that
		// when the scenario itself carries real analytical weight.
		const substantiveScenario =
			hasComplexityAnalysis ||
			hasProofOrFailureMode ||
			hasModelingOrDerivation ||
			hasTransferTrap;
		return { difficulty: substantiveScenario ? "medium" : "easy", score, reasons };
	}
	if (simplePrediction) {
		return { difficulty: "easy", score, reasons };
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

/**
 * A hard question that survives independent verification: no shallow-recall
 * flags and at least two verified reasoning moves. Domain-neutral — procedural
 * questions qualify through construction/constraint/state mechanics, and
 * conceptual/quantitative questions qualify through stacked reasoning moves.
 */
export function isDeepHardQuestion(
	question: QuestionDifficultyInput
): boolean {
	const estimate = estimateQuestionDifficulty(question);
	if (estimate.difficulty !== "hard") return false;

	const reasons = new Set(estimate.reasons);
	if (
		reasons.has("direct-one-step") ||
		reasons.has("tool-choice-only") ||
		reasons.has("bare-option-spotting") ||
		reasons.has("shallow-tool-recall") ||
		reasons.has("title-framed-without-concept")
	) {
		return false;
	}

	const proceduralMechanics = countReasonHits(reasons, [
		"procedural-composition",
		"procedural-multi-constraint",
		"output-or-state",
		"order-sensitivity",
	]);
	const substantialMoves = countReasonHits(reasons, [
		"code-or-trace",
		"proof-or-failure-mode",
		"complexity",
		"comparison",
		"modeling-or-derivation",
		"transfer-trap",
		"multi-condition",
		"multi-subtopic",
	]);
	const strongestProceduralMoves = countReasonHits(reasons, [
		"procedural-composition",
		"procedural-multi-constraint",
		"order-sensitivity",
	]);
	const deepProcedural =
		proceduralMechanics >= 2 && strongestProceduralMoves >= 1;
	const deepConceptual = substantialMoves >= 3;

	return (
		estimate.score >= 5.5 &&
		substantialMoves >= 2 &&
		(deepProcedural || deepConceptual)
	);
}

function countReasonHits(reasons: Set<string>, names: string[]): number {
	return names.filter((name) => reasons.has(name)).length;
}

function countMatches(value: string, pattern: RegExp): number {
	return [...value.matchAll(pattern)].length;
}

function isDirectOneStepQuestion(lowerQuestion: string): boolean {
	if (isNameSelectionRecallQuestion(lowerQuestion)) return true;
	if (isTokenDifferenceRecallQuestion(lowerQuestion)) return true;
	if (
		lowerQuestion.length >= 140 &&
		/\b(why|explain|derive|prove|counterexample|compare|construct|debug|predict)\b/.test(lowerQuestion)
	) {
		return false;
	}
	return /\b(what does it do|what is the returned|what is returned|which element is recorded|which half is eliminated|which half|who introduced|who discovered|which option|what is the name|which statement is true|select the correct)\b/.test(lowerQuestion) ||
		/\b(what|which)\s+(?:command|function|method|formula|tool|operator|keyword|tag|clause|reagent)\s+(?:prints?|shows?|displays?|lists?|finds?|searches?|changes?|creates?|removes?|copies?|moves?|computes?|returns?|produces?|gives?|yields?)\b/.test(lowerQuestion) ||
		/\b(what|which)\s+(?:boundary\s+)?update\b/.test(lowerQuestion) ||
		/\bwhat\s+update\s+(?:is|remains)\s+safe\b/.test(lowerQuestion) ||
		/\bwhat\s+is\s+the\s+(?:worst[- ]case|best[- ]case|average[- ]case|time|space)\s+complexity\b/.test(lowerQuestion) ||
		/\bwhich\s+(?:branch|condition|case)\b/.test(lowerQuestion) ||
		/\bwhen\b.+\bwhat does\b/.test(lowerQuestion) ||
		/\bafter\b.+\bwhat is the returned\b/.test(lowerQuestion);
}

/**
 * "Name the right tool/option/term" recall — pick or state a name without
 * having to construct, predict, debug, or justify anything. Domain-neutral:
 * commands, functions, formulas, reagents, clauses, and keywords all count.
 */
function isNameSelectionRecallQuestion(lowerQuestion: string): boolean {
	if (hasDeepReasoningCue(lowerQuestion)) return false;
	return /\b(which|what)\s+(?:command|option|flag|function|method|formula|operator|keyword|tag|clause|reagent|shortcut|switch)\b/.test(lowerQuestion) ||
		/\bwhich\s+one\s+(?:prints?|shows?|displays?|lists?|finds?|searches?|computes?|returns?)\b/.test(lowerQuestion) ||
		/\bwhat\s+does\s+(?:the\s+)?[^\s?]{1,30}\s+(?:connect|do|show|print|mean|return|stand\s+for)\b/.test(lowerQuestion) ||
		/\bwhat\s+does\s+`?-[a-z0-9-]+`?\s+(?:do|mean)\b/.test(lowerQuestion) ||
		/\bcompare\b.+\b(?:which one|which command|what command|which function|which method)\b/.test(lowerQuestion);
}

/**
 * Comparing two near-identical technical tokens (`ls` vs `ls -a`, `kill` vs
 * `kill -9`, `commit` vs `commit --amend`) where the answer is the meaning of
 * the differing flag/argument — single-fact recall dressed as comparison.
 */
function isTokenDifferenceRecallQuestion(lowerQuestion: string): boolean {
	if (hasDeepReasoningCue(lowerQuestion)) return false;
	if (!/\b(compare|versus|vs\.?|difference|differs?|while plain|instead of|rather than)\b/.test(lowerQuestion)) {
		return false;
	}
	const spans = [...lowerQuestion.matchAll(/`([^`\n]+)`/g)]
		.map((match) => match[1]!.trim().split(/\s+/).filter(Boolean))
		.filter((tokens) => tokens.length > 0);
	if (spans.length < 2) return false;

	// Same leading token with different token sets = a flag/argument variation
	// (recall). The same tokens rearranged = an order/evaluation question, which
	// is genuine reasoning, not recall.
	let hasFlagDifference = false;
	for (let i = 0; i < spans.length; i++) {
		for (let j = i + 1; j < spans.length; j++) {
			const a = spans[i]!;
			const b = spans[j]!;
			if (a[0] !== b[0]) continue;
			if (a.join(" ") === b.join(" ")) continue;
			if (sameTokenSet(a, b)) return false;
			hasFlagDifference = true;
		}
	}
	return hasFlagDifference;
}

function sameTokenSet(a: string[], b: string[]): boolean {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size !== setB.size) return false;
	for (const token of setA) {
		if (!setB.has(token)) return false;
	}
	return true;
}

function hasDeepReasoningCue(lowerQuestion: string): boolean {
	return /\b(construct|write|compose|build|debug|fix|repair|trace|derive|prove|counterexample|safest|safe|failure|fails?|trap|spaces|preserve|recursive|modified|one[- ]line|state after|end up|race|edge case)\b/.test(lowerQuestion);
}

/**
 * "Pick/write the right command or expression" MCQs with no requirement to
 * justify, debug, or predict — choosing a tool is not reasoning about it.
 */
function isToolChoiceOnlyQuestion(
	lowerQuestion: string,
	optionCount: number
): boolean {
	if (optionCount < 2) return false;
	if (
		!/\b(?:(?:which|choose|select)\s+(?:the\s+)?(?:command|query|expression|formula|function|call|statement)(?:\s+sequence|\s+pipeline)?|(?:write|give|provide)\s+(?:the\s+|a\s+)?(?:command|query|expression|formula)|what\s+(?:command|query|formula)\s+would\s+you\s+use)\b/.test(lowerQuestion)
	) {
		return false;
	}
	return !/\b(why|explain|justify|construct|debug|fix|trace|predict|derive|avoid|failure|trap|race|invariant)\b/.test(lowerQuestion);
}

/**
 * MCQ where most options (and the answer) are bare technical tokens — code,
 * commands, formulas — with no attached reasoning. The learner spots the
 * plausible-looking token instead of reasoning about why it works.
 */
function isBareTechnicalOptionChoice(
	options: string[],
	correctAnswer: string
): boolean {
	if (options.length < 2 || !isBareTechnicalOption(correctAnswer)) {
		return false;
	}
	const bareOptions = options.filter(isBareTechnicalOption).length;
	return bareOptions >= Math.ceil(options.length * 0.75);
}

function isBareTechnicalOption(option: string): boolean {
	const cleaned = option.trim().replace(/^`|`$/g, "").trim();
	if (!cleaned) return false;
	const lower = cleaned.toLowerCase();
	if (hasReasoningConnective(lower)) return false;
	// Technical shape: flags, paths, pipes, operators, calls, assignments.
	const looksTechnical =
		/(?:^|\s)--?[a-z0-9][\w-]*|[|<>&\\/=(){}[\];$%^*+]|\w\.\w|\d{2,}/.test(lower) &&
		!/[.!?]$/.test(cleaned);
	if (!looksTechnical) return false;
	// A bare token run, not prose: however long the expression, it carries no
	// English sentence structure explaining itself.
	return !/\b(the|a|an|because|which|that|this|it|is|are|was|were)\b/.test(lower);
}

function hasReasoningConnective(lower: string): boolean {
	return /\b(because|since|so that|therefore|avoids?|preserves?|keeps?|prevents?|handles?|fails? because|before|not after|trap|explicitly|ignores|applies|permanently|affected by|overrides?|ensures?|guarantees?)\b/.test(lower);
}

/**
 * Predicting the immediate result of one given expression with no state
 * chaining, no failure mode, and no interacting parts — a one-step check.
 */
function isSingleStepPredictionQuestion(lowerQuestion: string): boolean {
	if (!/\b(predict|what)\b.+\b(output|prints?|expands?|result)\b/.test(lowerQuestion)) {
		return false;
	}
	if (hasDeepReasoningCue(lowerQuestion)) return false;
	return !/\b(after|then|state|contents? of|intermediate|each step|sequence|order|combined|pipeline|versus|compare|error|status|process|signal)\b|[|]/.test(lowerQuestion);
}

function hasMultiStepTrace(combined: string): boolean {
	return /\b(trace|dry run|simulate|step through|after two|two iterations|multiple iterations|state after)\b/.test(combined) ||
		/\b(predict|trace)\b.+\b(?:output|state|contents? of)\b.+\b(?:output|state|contents? of)\b/.test(combined);
}

function hasFailureModeReasoning(combined: string): boolean {
	return /\b(counterexample|prove|proof|invariant|failure mode|violat(?:e|es|ing)|breaks?|edge case|corner case|boundary condition)\b/.test(combined);
}

function hasComplexityReasoning(combined: string): boolean {
	return /\b(derive|why|because|degrade|amortized|recurrence|worst[- ]case.+when|forces? .+\b(?:linear|logarithmic|quadratic|o\())\b/i.test(combined);
}

function hasTransferReasoning(combined: string): boolean {
	return /\b(new setting|variant|modified|construct|duplicate-heavy|debug|symptom|hidden condition|ambiguous|trap|subtle)\b/.test(combined);
}

interface ProceduralReasoning {
	hasComposition: boolean;
	hasMultiConstraint: boolean;
	hasOutputOrStateReasoning: boolean;
	hasOrderSensitivity: boolean;
	hasHardReasoning: boolean;
	hasSubstantialReasoning: boolean;
	hasShallowRecall: boolean;
}

/**
 * Domain-neutral procedural analysis. "Technical surface" is measured from
 * notation itself (inline code, fences, math spans, flags, pipes, calls,
 * operators) rather than any domain vocabulary, so shell pipelines, SQL, git,
 * spreadsheet formulas, regexes, and lab-protocol notation all register.
 */
function analyzeProceduralReasoning(
	combined: string,
	lowerQuestion: string
): ProceduralReasoning {
	const surface = technicalSurfaceScore(combined);
	const buildCue = /\b(construct|write|compose|build|design|implement|debug|fix|repair|modify|adapt|one[- ]line|which\s+(?:command|query|expression|formula)\s+sequence)\b/.test(combined);
	const predictTraceCue = /\b(predict|trace)\b/.test(combined);
	// Constraints must come from the question stem — option/answer text is full
	// of incidental "keep/when/if" phrasing that says nothing about the task.
	const constraintHits = countMatches(
		lowerQuestion,
		/\b(if|when|given|while|unless|without|except|including|but not|preserve|preserving|safely|keep(?:ing)?|at most|at least|exactly|must|avoid(?:ing)?|hidden|denied|recursive|modified)\b/g
	);
	const hasOutputOrStateReasoning =
		surface >= 1 &&
		/\b(output|prints?|produces?|returns?|results? in|evaluates? to|resulting|state|contents?|status|exit|error|ends? up|becomes?|left with|matches?|bits?|mode|count)\b/.test(combined);
	const hasOrderSensitivity =
		surface >= 2 &&
		/\b(order|ordering|precedence|precedes?|left[- ]to[- ]right|sequence|evaluat(?:es?|ed|ion)|reversed?|swapped)\b/.test(combined) &&
		/\b(trace|predict|explain why|differs?|versus|vs\.?|compare|state|end up|unexpectedly|why)\b/.test(combined) &&
		/\b(instead|unexpectedly|fails?|stays?|remains?|copied|differs?|changes?|swapped|reversed)\b/.test(combined);
	// Building something is composition outright; a pure predict/trace question
	// only counts as composition when the expression is genuinely multi-part
	// and scenario-constrained (otherwise it is one-step output recall).
	const hasComposition =
		(buildCue && surface >= 3) ||
		(predictTraceCue && surface >= 4 && constraintHits >= 1);
	const hasMultiConstraint =
		surface >= 3 && constraintHits >= 2;
	const hasHardReasoning = hasComposition || hasMultiConstraint || hasOrderSensitivity;
	const hasShallowRecallCue = /\b(what|which|why|explain|compare|difference|purpose|used for|does|prints?|shows?|lists?|displays?|connects?|stands? for|means?)\b/.test(combined);
	const hasDeepCue = hasDeepReasoningCue(combined);
	const hasShallowRecall =
		surface >= 1 &&
		hasShallowRecallCue &&
		!hasComposition &&
		!hasMultiConstraint &&
		!hasOrderSensitivity &&
		!hasDeepCue;
	return {
		hasComposition,
		hasMultiConstraint,
		hasOutputOrStateReasoning,
		hasOrderSensitivity,
		hasHardReasoning,
		hasSubstantialReasoning:
			hasHardReasoning &&
			(hasOutputOrStateReasoning ||
				hasOrderSensitivity ||
				/\b(debug|trace|predict|why|safe|failure|edge case|quote|space)\b/.test(combined)),
		hasShallowRecall,
	};
}

/**
 * How much executable/formal notation the question carries, independent of
 * domain. Counts inline code spans, fenced blocks, math spans, and loose
 * technical tokens (flags, pipes, redirects, paths, calls, assignments).
 */
function technicalSurfaceScore(combined: string): number {
	const codeSpans = countMatches(combined, /`[^`\n]+`/g);
	const fences = /```|~~~/.test(combined) ? 2 : 0;
	const mathSpans = countMatches(combined, /\$[^$\n]+\$/g);
	const technicalTokens = countUniqueMatches(
		combined,
		/(?:^|[\s("'])(?:--?[a-z0-9][\w-]*|[\w.$]+\([^)\n]*\)|\S+(?:[|/\\<>=]\S*)+|\d?[<>|]&?\d?)/g
	);
	return Math.min(4, codeSpans) + fences + Math.min(3, mathSpans) + Math.min(4, technicalTokens);
}

function countUniqueMatches(value: string, pattern: RegExp): number {
	return new Set([...value.matchAll(pattern)].map((match) => match[0].trim())).size;
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
