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
	const shellReasoning = analyzeShellReasoning(combined);
	const shellChoiceOnly = isShellChoiceOnlyQuestion(
		lowerQuestion,
		question.options?.length ?? 0
	);
	const shellCommandOptionSpotting = isBareShellCommandOptionChoice(
		question.options ?? [],
		question.correctAnswer
	);
	const simpleShellPrediction = isSimpleShellPredictionQuestion(lowerQuestion);
	const conditionCount = countMatches(lowerQuestion, /\b(if|when|given|consider|suppose|after|under|unless|while)\b/g);
	const hasMultiCondition = conditionCount >= 2 || questionText.length >= 210;
	const sourceSubtopicCount = question.sourceSubtopics?.length ?? 0;
	const titleFramed = hasTitleFraming(question);
	const directOneStep =
		isDirectOneStepQuestion(lowerQuestion) ||
		shellReasoning.hasShallowRecall ||
		shellChoiceOnly;

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
	if (shellReasoning.hasCommandComposition) add(1.4, "shell-command-composition");
	if (shellReasoning.hasMultiConstraint) add(1.2, "shell-multi-constraint");
	if (shellReasoning.hasOutputOrStateReasoning) add(0.9, "shell-output-or-state");
	if (shellReasoning.hasDescriptorOrderReasoning) add(1.6, "shell-descriptor-order");
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
	if (shellReasoning.hasShallowRecall) {
		score -= 0.8;
		reasons.push("shell-shallow-recall");
	}
	if (shellChoiceOnly) {
		score -= 0.6;
		reasons.push("shell-choice-only");
	}
	if (shellCommandOptionSpotting) {
		score -= 1.2;
		reasons.push("shell-command-option-spotting");
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
		shellReasoning.hasHardReasoning,
	].filter(Boolean).length;
	const substantialReasoningMoves = [
		hasMultiStepTrace(combined),
		hasFailureModeReasoning(combined),
		hasComplexityReasoning(combined),
		hasComparisonOrTradeoff,
		hasModelingOrDerivation,
		hasTransferReasoning(combined),
		shellReasoning.hasSubstantialReasoning,
	].filter(Boolean).length;

	if (
		!directOneStep &&
		!shellChoiceOnly &&
		!shellCommandOptionSpotting &&
		!simpleShellPrediction &&
		score >= 5 &&
		reasoningCategories >= 2 &&
		substantialReasoningMoves >= 2 &&
		(hasMultiCondition ||
			hasWhyOrExplain ||
			hasComplexityAnalysis ||
			hasProofOrFailureMode ||
			shellReasoning.hasMultiConstraint)
	) {
		return { difficulty: "hard", score, reasons };
	}
	if (shellChoiceOnly) {
		return { difficulty: "easy", score, reasons };
	}
	if (shellCommandOptionSpotting) {
		return { difficulty: "medium", score, reasons };
	}
	if (simpleShellPrediction) {
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

export function isDeepShellHardQuestion(
	question: QuestionDifficultyInput
): boolean {
	const estimate = estimateQuestionDifficulty(question);
	if (estimate.difficulty !== "hard") return false;

	const reasons = new Set(estimate.reasons);
	if (
		reasons.has("direct-one-step") ||
		reasons.has("shell-choice-only") ||
		reasons.has("shell-command-option-spotting") ||
		reasons.has("shell-shallow-recall") ||
		reasons.has("title-framed-without-concept")
	) {
		return false;
	}

	const shellMechanics = countReasonHits(reasons, [
		"shell-command-composition",
		"shell-multi-constraint",
		"shell-output-or-state",
		"shell-descriptor-order",
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
	const strongestShellMoves = countReasonHits(reasons, [
		"shell-command-composition",
		"shell-multi-constraint",
		"shell-descriptor-order",
	]);

	return (
		estimate.score >= 5.5 &&
		shellMechanics >= 2 &&
		strongestShellMoves >= 1 &&
		substantialMoves >= 2
	);
}

function countReasonHits(reasons: Set<string>, names: string[]): number {
	return names.filter((name) => reasons.has(name)).length;
}

function countMatches(value: string, pattern: RegExp): number {
	return [...value.matchAll(pattern)].length;
}

function isDirectOneStepQuestion(lowerQuestion: string): boolean {
	if (isDirectShellRecallQuestion(lowerQuestion)) return true;
	if (
		lowerQuestion.length >= 140 &&
		/\b(why|explain|derive|prove|counterexample|compare|construct|debug|predict)\b/.test(lowerQuestion)
	) {
		return false;
	}
	return /\b(what does it do|what is the returned|what is returned|which element is recorded|which half is eliminated|which half|who introduced|who discovered|which option|what is the name|which statement is true|select the correct)\b/.test(lowerQuestion) ||
		/\b(what|which)\s+command\s+(?:prints?|shows?|displays?|lists?|finds?|searches?|changes?|creates?|removes?|copies?|moves?)\b/.test(lowerQuestion) ||
		/\b(what|which)\s+(?:boundary\s+)?update\b/.test(lowerQuestion) ||
		/\bwhat\s+update\s+(?:is|remains)\s+safe\b/.test(lowerQuestion) ||
		/\bwhat\s+is\s+the\s+(?:worst[- ]case|best[- ]case|average[- ]case|time|space)\s+complexity\b/.test(lowerQuestion) ||
		/\bwhich\s+(?:branch|condition|case)\b/.test(lowerQuestion) ||
		/\bwhen\b.+\bwhat does\b/.test(lowerQuestion) ||
		/\bafter\b.+\bwhat is the returned\b/.test(lowerQuestion);
}

function isDirectShellRecallQuestion(lowerQuestion: string): boolean {
	if (
		/\b(construct|debug|fix|safest|safe|failure|trap|spaces|permission denied|stderr|stdout|xargs|quoting|recursive|modified|preserve|one[- ]line|derive)\b/.test(lowerQuestion)
	) {
		return false;
	}
	return /\b(which|what)\s+(?:command|option)\b/.test(lowerQuestion) ||
		/\bwhich\s+one\s+(?:prints?|shows?|displays?|lists?|finds?|searches?)\b/.test(lowerQuestion) ||
		/\bwhat\s+does\s+(?:the\s+)?(?:pipe|command|option)\s+(?:connect|do|show|print)\b/.test(lowerQuestion) ||
		/\bwhat\s+does\s+`?-[a-z0-9-]+`?\s+(?:do|mean)\b/.test(lowerQuestion) ||
		/\bcompare\b.+\b(?:which one|which command|what command)\b/.test(lowerQuestion);
}

function isShellChoiceOnlyQuestion(
	lowerQuestion: string,
	optionCount: number
): boolean {
	if (optionCount < 2) return false;
	if (
		!/\b(?:(?:which|choose|select)\s+(?:the\s+)?command(?:\s+sequence|\s+pipeline)?|(?:write|give|provide)\s+(?:the\s+|a\s+)?command|what\s+command\s+would\s+you\s+use)\b/.test(lowerQuestion)
	) {
		return false;
	}
	return !/\b(why|explain|justify|construct|debug|fix|trace|predict|derive|avoid|failure|trap|race|invariant)\b/.test(lowerQuestion);
}

function isBareShellCommandOptionChoice(
	options: string[],
	correctAnswer: string
): boolean {
	if (options.length < 2 || !isBareShellCommandOption(correctAnswer)) {
		return false;
	}
	const bareCommandOptions = options.filter(isBareShellCommandOption).length;
	return bareCommandOptions >= Math.ceil(options.length * 0.75);
}

function isBareShellCommandOption(option: string): boolean {
	const cleaned = option.trim().replace(/^`|`$/g, "");
	if (!cleaned) return false;
	const lower = cleaned.toLowerCase();
	if (
		/\b(because|since|so that|therefore|avoids?|preserves?|keeps?|prevents?|handles?|fails? because|redirects? before|not after|trap|spaces in filenames|permission denied|null-delimited|left-to-right|is masked|would start|explicitly|ignores|applies|permanently|affected by|overrides?)\b/.test(lower)
	) {
		return false;
	}
	return /^`?\s*(?:sudo\s+|env\s+)?(?:cd|pwd|ls|cat|less|more|head|tail|wc|grep|find|xargs|chmod|chown|umask|uname|who|last|ps|kill|jobs|fg|bg|mkdir|touch|cp|mv|rm|ln|sort|uniq|cut|awk|sed|echo|tee)\b/.test(lower);
}

function isSimpleShellPredictionQuestion(lowerQuestion: string): boolean {
	if (!/\b(predict|what)\b.+\b(output|prints?|expands?|result)\b/.test(lowerQuestion)) {
		return false;
	}
	return !/\b(pipe|pipeline|\||stderr|stdout|file descriptor|xargs|find|permission denied|process|signal|inode|link count|terminal output|contents? of|debug|fix|failure|trap|race|after|state)\b/.test(lowerQuestion);
}

function hasMultiStepTrace(combined: string): boolean {
	return /\b(trace|dry run|simulate|step through|after two|two iterations|multiple iterations|state after)\b/.test(combined) ||
		/\b(predict|trace)\b.+\b(?:terminal output|stdout|stderr|contents? of)\b.+\b(?:terminal output|stdout|stderr|contents? of)\b/.test(combined);
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

function analyzeShellReasoning(combined: string): {
	hasCommandComposition: boolean;
	hasMultiConstraint: boolean;
	hasOutputOrStateReasoning: boolean;
	hasDescriptorOrderReasoning: boolean;
	hasHardReasoning: boolean;
	hasSubstantialReasoning: boolean;
	hasShallowRecall: boolean;
} {
	const shellConcepts = [
		/\b(pipe|pipes|pipeline|\||redirection|redirect|stdin|stdout|stderr|file descriptor|2>|2>&1|tee|filter|xargs|command substitution)\b/,
		/\b(permission|permissions|chmod|umask|owner|group|execute bit|sticky bit|setuid|setgid)\b/,
		/\b(process|processes|job|jobs|signal|signals|kill|pkill|pgrep|pidof|foreground|background)\b/,
		/\b(find|grep|sort|uniq|cut|awk|sed|wildcard|wildcards|glob|globbing|quote|quoting)\b/,
		/\b(hard link|symbolic link|symlink|inode|mount|path|directory tree)\b/,
	];
	const conceptHits = shellConcepts.filter((pattern) => pattern.test(combined)).length;
	const commandHits = countUniqueMatches(
		combined,
		/\b(cd|pwd|ls|cat|less|more|head|tail|wc|grep|find|xargs|chmod|chown|umask|uname|who|last|ps|kill|jobs|fg|bg|mkdir|touch|cp|mv|rm|ln|sort|uniq|cut|awk|sed|echo|tee)\b/g
	);
	const constructionCue = /\b(construct|write|choose|debug|fix|predict|trace|explain why|which command sequence|one[- ]line command|pipeline|redirect)\b/.test(combined);
	const constraintHits = countMatches(
		combined,
		/\b(if|when|given|while|unless|without|except|including|but not|preserve|safely|spaces|hidden|permission denied|stderr|stdout|recursive|modified|owner|group)\b/g
	);
	const hasOutputOrStateReasoning = /\b(output|prints?|matches?|exit status|permission bits?|mode|inode|link count|process state|signal|foreground|background|stderr|stdout)\b/.test(combined);
	const hasDescriptorOrderReasoning =
		/\b(?:file descriptor|descriptor|fd|redirection order|left[- ]to[- ]right|2>&1|stdout|stderr)\b/.test(combined) &&
		/\b(?:trace|predict|explain why|differs?|versus|vs\.?|after each redirection|state)\b/.test(combined) &&
		/\b(?:stdout|stderr|2>|2>&1|file descriptor|descriptor|fd)\b/.test(combined);
	const hasCommandComposition =
		(conceptHits >= 2 && constructionCue) ||
		(conceptHits >= 1 && commandHits >= 3 && constructionCue);
	const hasMultiConstraint =
		(conceptHits >= 2 && constraintHits >= 2) ||
		(conceptHits >= 1 && commandHits >= 3 && constraintHits >= 2);
	const hasHardReasoning = hasCommandComposition || hasMultiConstraint || hasDescriptorOrderReasoning;
	const hasShellSurface = conceptHits >= 1 || commandHits >= 1 || /\blinux commands?\b|\bshell\b|\bterminal\b/.test(combined);
	const hasShallowRecallCue = /\b(what|which|why|explain|compare|difference|purpose|used for|does|prints?|shows?|lists?|displays?|connects?)\b/.test(combined);
	const hasDeepShellCue = /\b(construct|write|debug|fix|predict|trace|derive|safest|safe one[- ]line|failure|trap|preserve|permission denied|spaces|recursive|modified|null[- ]delimited|race|quoting)\b/.test(combined);
	const hasShallowRecall =
		hasShellSurface &&
		hasShallowRecallCue &&
		!hasMultiConstraint &&
		!hasCommandComposition &&
		!hasDescriptorOrderReasoning &&
		!hasDeepShellCue;
	return {
		hasCommandComposition,
		hasMultiConstraint,
		hasOutputOrStateReasoning: hasOutputOrStateReasoning && conceptHits >= 1,
		hasDescriptorOrderReasoning,
		hasHardReasoning,
		hasSubstantialReasoning:
			hasHardReasoning &&
			(hasOutputOrStateReasoning ||
				hasDescriptorOrderReasoning ||
				/\b(debug|trace|predict|why|safe|failure|edge case|quote|space)\b/.test(combined)),
		hasShallowRecall,
	};
}

function countUniqueMatches(value: string, pattern: RegExp): number {
	return new Set([...value.matchAll(pattern)].map((match) => match[0])).size;
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
