import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { buildPrompt, outputTokenBudget, resolvePromptParts } from "../src/llm/prompt";
import type { StructuredPrompt, TopicContext } from "../src/llm/prompt";
import {
	geminiQuestionSchema,
	modelHasAlwaysOnThinking,
	modelOmitsSamplingParams,
	questionSchema,
} from "../src/llm/openai-shared";
import {
	FlowSessionGenerator,
	FlowSignal,
	flowSkillAdjustment,
	planFlowBatches,
	planUpfrontBatches,
} from "../src/practice/flow-engine";
import { parseQuestions } from "../src/llm/parse";
import {
	detectFormatIssues,
	escapeBareHighlights,
	normalizeObsidianMath,
	normalizeQuestionFormatting,
	repairMathBraces,
} from "../src/llm/format-normalize";
import {
	extractProviderErrorDetail,
	formatProviderError,
	isSamplingParamRejection,
	isStructuredOutputRejection,
	isThinkingConfigRejection,
} from "../src/llm/errors";
import {
	buildOpenAiResponsesBody,
	getOpenAiResponsesText,
	normalizeOpenAiResponsesUrl,
} from "../src/llm/openai-responses-format";
import {
	formatBytes,
	MAX_PDF_ATTACHMENT_BYTES,
	pdfAttachmentSizeError,
} from "../src/notes/attachment-budget";
import {
	cleanMarkdownPath,
	cleanNoteText,
	extractSections,
	parseMarkdownImageReferences,
	parseInternalEmbedReference,
	parseSkillValue,
} from "../src/notes/normalize";
import { noteDisplayAliases, noteDisplayTitle } from "../src/notes/titles";
import { shouldAttachPromptMedia } from "../src/notes/attachment-policy";
import {
	buildQuestionHistoryBlock,
	removeQuestionHistoryEntry,
} from "../src/notes/history-format";
import {
	buildRemotePromptAttachment,
	isSafeRemoteAttachmentUrl,
} from "../src/notes/remote-media";
import { LocalMediaLink, mergeLocalMediaLink } from "../src/notes/media-links";
import { extractConceptCandidates } from "../src/notes/concepts";
import {
	frontmatterDateMs,
	normalizeDatePropertyNames,
} from "../src/notes/frontmatter-dates";
import { sanitizeFrontmatter } from "../src/notes/frontmatter";
import {
	averageFluency,
	checkAnswer,
	computeSkillDeltas,
	resultFluency,
} from "../src/practice/grader";
import {
	dailyTopicCandidateLimitForProvider,
	getProviderAttachmentSupport,
	getProviderPdfWarning,
	splitProviderCompatibleTopics,
} from "../src/practice/provider-capabilities";
import { isIndexEntryCurrent } from "../src/practice/index-freshness";
import { shouldYieldScanBatch } from "../src/practice/scan-batches";
import {
	getProviderSecretId,
	getProviderSecretName,
	normalizeProviderSecretNames,
	setProviderSecretName,
	syncLegacySecretName,
} from "../src/practice/provider-secrets";
import {
	getSecretSafely,
	setSecretSafely,
} from "../src/practice/secret-storage";
import {
	migrateProviderModel,
	normalizeProviderModels,
	providerModelsNeedNormalization,
	setProviderModelOverride,
} from "../src/practice/provider-models";
import {
	evaluatePracticeSessionMeaningfulness,
	isMeaningfulPracticeSession,
	normalizePracticeMemory,
	planDailySession,
	reconcilePracticeMemory,
	recordDailyReminderAttempt,
	reminderAttemptCooldownHasPassed,
	selectDailyTopics,
	selectPracticeMoreTopics,
	shouldOfferDailyReminder,
	suppressDailyReminderForToday,
	updatePracticeMemoryAfterSession,
	retrievability,
	intervalForRetention,
	nextStabilityDays,
} from "../src/practice/scheduler";
import {
	migratePdfSkillPaths,
	migratePracticeMemoryPaths,
	prunePdfSkillPaths,
	prunePracticeMemoryPaths,
	remapPath,
} from "../src/practice/path-migration";
import { resolvePracticeCredit } from "../src/practice/daily-credit";
import { hasPracticedToday } from "../src/practice/daily-status";
import { recordQuestionFeedback } from "../src/practice/question-feedback";
import {
	reconcileGeneratedQuestions,
	reconcileSourceTopics,
	resolveQuestionTargetTopics,
} from "../src/practice/source-map";
import {
	buildAnswerVerificationPrompt,
	buildChallengeTopUpPrompt,
	buildQuestionTopUpPrompt,
	mergeQuestionBatches,
} from "../src/practice/question-quality";
import {
	calibrateQuestionsForPractice,
} from "../src/practice/question-calibration";
import {
	challengeShortfallMessage,
	desiredDifficultyCounts,
	isStrictChallengeSession,
	selectFlowBalancedQuestions,
	prepareGeneratedQuestionsForSession,
	shouldRequestChallengeTopUp,
} from "../src/practice/flow-calibration";
import {
	isDeepHardQuestion,
	normalizeQuestionDifficulty,
} from "../src/practice/difficulty-quality";
import {
	adaptQuestionOrderForFlow,
	nextTargetDifficulty,
} from "../src/practice/flow-navigation";
import {
	buildPracticeDraft,
	normalizePracticeDraft,
	practiceDraftProgress,
	shouldConfirmPracticeDraftReplacement,
} from "../src/practice/draft";
import {
	applyAnswerVerification,
	applyDeepAuthoring,
	generateQuestionsFromClient,
} from "../src/practice/generation-loop";
import type { LlmClient } from "../src/practice/generation-loop";
import {
	ANALYTICAL_MOVES,
	buildDeepAuthoringPrompt,
	renderAnalyticalMovesGuidance,
} from "../src/llm/analytical-moves";
import { folderLabel, stringifyGroupValue } from "../src/ui/topic-groups";
import { hasBlockMarkdown } from "../src/ui/markdown-detection";
import { normalizeMarkdownForRender } from "../src/ui/markdown-normalize";
import {
	AdaptivePracticeSettings,
	PracticeMemory,
	NoteIndexEntry,
	NoteStructure,
	NoteMediaReference,
	DEFAULT_SETTINGS,
	PROVIDER_PRESETS,
	Question,
	QuestionFeedbackEntry,
	QuizResult,
	SessionConfig,
	SkillDelta,
	TopicNote,
} from "../src/types";

type TestCase = {
	name: string;
	run: () => void | Promise<void>;
};

const tests: TestCase[] = [];

function test(name: string, run: () => void | Promise<void>): void {
	tests.push({ name, run });
}

test("parseQuestions accepts wrapped fenced JSON and normalizes MCQ options", () => {
	const questions = parseQuestions(`\`\`\`json
{
  "questions": [
    {
      "id": "rotated-1",
      "type": "mcq",
      "questionText": "Which invariant survives the rotation pivot?",
      "options": [
        "A) left half is always sorted",
        "B. one half is always sorted",
        "C. neither side can be sorted",
        "D. both halves are always sorted"
      ],
      "correctAnswer": "B. one half is always sorted",
      "explanation": "At least one side of the midpoint remains sorted.",
      "sourceTopics": ["Rotated binary search"],
      "sourceSubtopics": ["pivot invariant"],
      "difficulty": "hard"
    }
  ]
}
\`\`\``);

	assert.equal(questions.length, 1);
	const question = questions[0];
	assert.ok(question);
	assert.equal(question.id, "rotated-1");
	assert.deepEqual(new Set(question.options), new Set([
		"left half is always sorted",
		"one half is always sorted",
		"neither side can be sorted",
		"both halves are always sorted",
	]));
	assert.equal(question.correctAnswer, "one half is always sorted");
	assert.notEqual(question.options?.indexOf(question.correctAnswer), 1);
	assert.deepEqual(question.sourceSubtopics, ["pivot invariant"]);
});

test("parseQuestions extracts JSON from provider chatter and resolves letter answers", () => {
	const questions = parseQuestions(`Sure — here is the JSON:

\`\`\`json
{
  "questions": [
    {
      "id": "q-letter",
      "type": "mcq",
      "questionText": "Which branch contains the minimum when nums[mid] > nums[right]?",
      "options": ["A. left half", "B. right half", "C. both halves", "D. neither half"],
      "correctAnswer": "B",
      "explanation": "The rotation pivot must be to the right of mid.",
      "sourceTopics": ["Rotated binary search"],
      "sourceSubtopics": ["pivot invariant"],
      "difficulty": "medium"
    }
  ]
}
\`\`\`

	Hope that helps.`);

	assert.equal(questions.length, 1);
	assert.deepEqual(new Set(questions[0]?.options), new Set([
		"left half",
		"right half",
		"both halves",
		"neither half",
	]));
	assert.equal(questions[0]?.correctAnswer, "right half");
	assert.notEqual(questions[0]?.options?.indexOf("right half"), 1);
});

test("parseQuestions skips non-JSON code fences before the question payload", () => {
	const payload = JSON.stringify({
		questions: [
			{
				id: "verilog-fence",
				type: "mcq",
				questionText: "What does the continuous assignment do?",
				options: [
					"A. Drives y from a and b",
					"B. Stores y on a clock edge",
					"C. Declares a module input",
					"D. Resets y asynchronously",
				],
				correctAnswer: "A",
				explanation: "A continuous assign drives a wire from the expression.",
				sourceTopics: ["Verilog"],
				sourceSubtopics: ["continuous assignment"],
				difficulty: "easy",
			},
		],
	});

	const questions = parseQuestions(`Example code:

\`\`\`verilog
assign y = a & b;
\`\`\`

Question JSON:
${payload}
`);

	assert.equal(questions.length, 1);
	assert.equal(questions[0]?.id, "verilog-fence");
	assert.equal(questions[0]?.correctAnswer, "Drives y from a and b");
});

test("parseQuestions shuffles MCQ options while preserving terminal options", () => {
	const questions = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "terminal-option",
				type: "mcq",
				questionText: "Which statements about binary search invariants are true?",
				options: [
					"A. The interval invariant must hold after each update",
					"B. Midpoint overflow can be avoided with low + floor((high-low)/2)",
					"C. The algorithm can ignore boundary movement",
					"D. All of the above",
				],
				correctAnswer: "B",
				explanation: "Only the midpoint overflow statement is true as written.",
				sourceTopics: ["Binary search"],
				sourceSubtopics: ["invariants"],
				difficulty: "medium",
			},
		],
	}));

	assert.equal(questions.length, 1);
	const options = questions[0]?.options ?? [];
	assert.equal(options[options.length - 1], "All of the above");
	assert.equal(questions[0]?.correctAnswer, "Midpoint overflow can be avoided with low + floor((high-low)/2)");
	assert.notEqual(options.indexOf(questions[0]?.correctAnswer ?? ""), 1);
});

test("parseQuestions accepts a single question object embedded in text", () => {
	const questions = parseQuestions(`
Some providers ignore the array instruction.
{
  "id": "single",
  "type": "integer",
  "questionText": "How many pointers move in the duplicate worst case?",
  "correctAnswer": 2,
  "explanation": "Both low and high shrink.",
  "sourceTopics": ["Rotated binary search"],
  "difficulty": "hard"
}
`);

	assert.equal(questions.length, 1);
	assert.equal(questions[0]?.id, "single");
	assert.equal(questions[0]?.type, "integer");
	assert.equal(questions[0]?.correctAnswer, "2");
});

test("parseQuestions drops malformed questions before they reach the quiz UI", () => {
	const questions = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "valid",
				type: "mcq",
				questionText: "Which invariant matters when the midpoint is larger than the right edge?",
				options: [
					"A. pivot is in the right half",
					"B. pivot is always at mid",
					"C. array is definitely unrotated",
					"D. left pointer must move backward",
				],
				correctAnswer: "A",
				sourceTopics: ["Rotated binary search"],
				difficulty: "medium",
			},
			{
				id: "blank",
				type: "mcq",
				options: ["A. one", "B. two", "C. three", "D. four"],
				correctAnswer: "A",
			},
			{
				id: "bad-options",
				type: "mcq",
				questionText: "Why is this invalid?",
				options: ["A. one", "B. two"],
				correctAnswer: "A",
			},
			{
				id: "bad-answer",
				type: "mcq",
				questionText: "Which answer should be rejected?",
				options: ["A. one", "B. two", "C. three", "D. four"],
				correctAnswer: "E",
			},
		],
	}));

	assert.equal(questions.length, 1);
	assert.equal(questions[0]?.id, "valid");
	assert.equal(questions[0]?.correctAnswer, "pivot is in the right half");
	assert.equal(questions[0]?.explanation, "No explanation provided by the model.");
});

test("parseQuestions validates numeric question answers before grading", () => {
	const questions = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "valid-decimal",
				type: "decimal",
				questionText: "What is one half as a decimal target?",
				correctAnswer: "\\frac{1}{2}",
				explanation: "The fraction is parseable as 0.5.",
				sourceTopics: ["Fractions"],
				difficulty: "medium",
			},
			{
				id: "valid-integer",
				type: "integer",
				questionText: "How many pointers shrink in the duplicate worst case?",
				correctAnswer: "$2$",
				explanation: "Both low and high can move.",
				sourceTopics: ["Rotated binary search"],
				difficulty: "hard",
			},
			{
				id: "bad-integer",
				type: "integer",
				questionText: "This should not be accepted.",
				correctAnswer: "two pointers",
				explanation: "No parseable number.",
				sourceTopics: ["Rotated binary search"],
				difficulty: "medium",
			},
			{
				id: "bad-integer-decimal",
				type: "integer",
				questionText: "Integer labels should not accept non-integers.",
				correctAnswer: "3.14",
				explanation: "Not integer-like.",
				sourceTopics: ["Numbers"],
				difficulty: "medium",
			},
			{
				id: "bad-decimal",
				type: "decimal",
				questionText: "This should not be accepted either.",
				correctAnswer: "approximately many",
				explanation: "No numeric target.",
				sourceTopics: ["Numbers"],
				difficulty: "medium",
			},
		],
	}));

	assert.deepEqual(questions.map((question) => question.id), [
		"valid-decimal",
		"valid-integer",
	]);
	assert.equal(questions[0]?.correctAnswer, "\\frac{1}{2}");
	assert.equal(questions[1]?.correctAnswer, "$2$");
});

test("parseQuestions downgrades inflated hard labels for direct recall", () => {
	const questions = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "trivial-hard",
				type: "mcq",
				questionText: "Who introduced the binary search algorithm?",
				options: [
					"John Mauchly",
					"Hermann Bottenbruch",
					"Ada Lovelace",
					"Alan Kay",
				],
				correctAnswer: "Hermann Bottenbruch",
				explanation: "The note mentions Bottenbruch in the implementation history.",
				sourceTopics: ["Binary search"],
				sourceSubtopics: ["History"],
				difficulty: "hard",
			},
		],
	}));

	assert.equal(questions.length, 1);
	assert.equal(questions[0]?.difficulty, "easy");
});

test("parseQuestions independently marks one-step algorithm branch checks as easy", () => {
	const questions = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "branch-easy",
				type: "mcq",
				questionText: "In the First and Last Occurrence problem, the binary search approach for finding the first occurrence does something different when `nums[mid] == target` compared to a standard binary search. What does it do?",
				options: [
					"Records mid as a candidate answer and continues searching in the left half by setting high = mid - 1",
					"Returns mid immediately since the target is found",
					"Records mid as a candidate answer and continues searching in the right half by setting low = mid + 1",
					"Sets low = mid to keep mid in the search space",
				],
				correctAnswer: "Records mid as a candidate answer and continues searching in the left half by setting high = mid - 1",
				explanation: "The branch saves mid and keeps searching left for a smaller valid index.",
				sourceTopics: ["First and Last Occurrence"],
				sourceSubtopics: ["first occurrence branch"],
				difficulty: "medium",
			},
		],
	}));

	assert.equal(questions.length, 1);
	assert.equal(questions[0]?.difficulty, "easy");
});

test("parseQuestions downgrades edge-case update recall despite hard wording", () => {
	const questions = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "direct-edge-update",
				type: "mcq",
				questionText: "In the duplicate edge case when `nums[low] == nums[mid] == nums[high]`, what boundary update is safe?",
				options: [
					"Increment low and decrement high",
					"Return false immediately",
					"Set high = mid - 1 only",
					"Set low = mid only",
				],
				correctAnswer: "Increment low and decrement high",
				explanation: "Equal boundaries hide the sorted half, so shrinking both ends is the safe fallback.",
				sourceTopics: ["Rotated binary search"],
				sourceSubtopics: ["duplicate edge case"],
				difficulty: "hard",
			},
		],
	}));

	assert.equal(questions.length, 1);
	assert.equal(questions[0]?.difficulty, "easy");
});

test("parseQuestions downgrades direct complexity recall to medium", () => {
	const questions = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "complexity-recall",
				type: "mcq",
				questionText: "What is the worst-case time complexity of rotated sorted array search with duplicates?",
				options: [
					"$O(\\log n)$",
					"$O(n)$",
					"$O(n \\log n)$",
					"$O(1)$",
				],
				correctAnswer: "$O(n)$",
				explanation: "Duplicate trimming can shrink the interval one element at a time.",
				sourceTopics: ["Rotated binary search"],
				sourceSubtopics: ["duplicate worst-case complexity"],
				difficulty: "hard",
			},
		],
	}));

	assert.equal(questions.length, 1);
	assert.equal(questions[0]?.difficulty, "medium");
});

test("parseQuestions preserves hard labels for transfer and edge-case reasoning", () => {
	const questions = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "real-hard",
				type: "mcq",
				questionText: "You run rotated sorted array search with duplicates on `nums = [3, 3, 3, 3]` and target `4`. In the worst case, why does the duplicate-trimming branch degrade the search, and what boundary update is still safe?",
				options: [
					"It stays O(log n), because every comparison halves the array.",
					"It can become O(n), because equal low/mid/high values force shrinking boundaries one step at a time without proving a sorted half.",
					"It becomes O(n log n), because every duplicate requires a nested binary search.",
					"It becomes O(sqrt n), because duplicate runs are skipped in square-root blocks.",
				],
				correctAnswer: "It can become O(n), because equal low/mid/high values force shrinking boundaries one step at a time without proving a sorted half.",
				explanation: "The equal-boundary edge case hides the invariant that one side is sorted, so the safe fallback only increments low and decrements high.",
				sourceTopics: ["Rotated binary search"],
				sourceSubtopics: ["duplicate edge case", "complexity"],
				difficulty: "hard",
			},
		],
	}));

	assert.equal(questions.length, 1);
	assert.equal(questions[0]?.difficulty, "hard");
});

test("flow calibration asks for challenge top-up when a generated batch is too easy", () => {
	const topic = makeTopic({ skill: 72 });
	const easyQuestions = Array.from({ length: 6 }, (_, index) =>
		makeQuestion({
			id: `easy-${index}`,
			questionText: `What direct branch update is used in case ${index}?`,
			correctAnswer: "Save the candidate.",
			difficulty: "easy",
		})
	);
	const harder = [
		makeQuestion({
			id: "hard-transfer",
			questionText: "Construct a duplicate-heavy rotated-array case where the sorted-half invariant cannot be proven, then identify the safe boundary update and worst-case complexity.",
			correctAnswer: "Equal boundaries force shrinking both ends, giving linear worst case.",
			difficulty: "hard",
		}),
		makeQuestion({
			id: "medium-trace",
			questionText: "Trace two iterations and explain why the left boundary update preserves the invariant.",
			correctAnswer: "The target remains in the closed interval.",
			difficulty: "medium",
		}),
	];

	assert.equal(shouldRequestChallengeTopUp(easyQuestions, [topic], "steady"), true);
	const balanced = selectFlowBalancedQuestions(
		easyQuestions,
		harder,
		6,
		[topic],
		"steady"
	);

	assert.ok(balanced.some((question) => question.difficulty === "hard"));
	assert.ok(balanced.some((question) => question.difficulty === "medium"));
});

test("flow calibration rejects under-challenging high-skill batches", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const desired = desiredDifficultyCounts(8, topic.skill, "steady");
	const easyBatch = Array.from({ length: 8 }, (_, index) =>
		makeQuestion({
			id: `easy-${index}`,
			questionText: `Which command prints direct fact ${index}?`,
			correctAnswer: "uname",
			difficulty: "easy",
		})
	);
	const allMediumBatch = Array.from({ length: 8 }, (_, index) =>
		makeQuestion({
			id: `medium-${index}`,
			questionText: `Explain a routine shell behavior ${index}.`,
			correctAnswer: "The shell expands it before execution.",
			difficulty: "medium",
		})
	);
	const tooShortHardBatch = Array.from({ length: 3 }, (_, index) =>
		makeQuestion({
			id: `short-hard-${index}`,
			questionText: `Construct a shell pipeline with quoting and stderr redirection for case ${index}.`,
			correctAnswer: "Use null-delimited input and redirect stderr before the pipe.",
			difficulty: "hard",
		})
	);
	const replacementGrade = [
		...Array.from({ length: desired.hard }, (_, index) =>
			makeLinuxHardQuestion(`replacement-hard-${index}`)
		),
		...Array.from({ length: desired.medium }, (_, index) =>
			makeLinuxMediumQuestion(`medium-replacement-${index}`)
		),
	];

	assert.deepEqual(desired, { easy: 0, medium: 2, hard: 6 });
	assert.deepEqual(desiredDifficultyCounts(8, topic.skill, "stretch"), {
		easy: 0,
		medium: 2,
		hard: 6,
	});
	assert.equal(isStrictChallengeSession([topic], "steady"), true);
	assert.equal(shouldRequestChallengeTopUp(easyBatch, [topic], "steady"), true);
	assert.equal(shouldRequestChallengeTopUp(allMediumBatch, [topic], "steady"), true);
	assert.match(
		challengeShortfallMessage(easyBatch, [topic], "steady", 8),
		/high-skill topic "Linux Commands".*Expected about 0 easy, 2 medium, 6 hard for that topic; got 8 easy, 0 medium, 0 hard/
	);
	assert.match(
		challengeShortfallMessage(tooShortHardBatch, [topic], "steady", 8),
		/Generated only 3 of 8 questions.*Expected about 0 easy, 2 medium, 6 hard; got 0 easy, 0 medium, 3 hard/
	);

	const balanced = selectFlowBalancedQuestions(
		easyBatch,
		replacementGrade,
		8,
		[topic],
		"steady"
	);

	assert.equal(balanced.filter((question) => question.difficulty === "easy").length, 0);
	assert.equal(balanced.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(balanced.filter((question) => question.difficulty === "medium").length, 2);
	assert.equal(challengeShortfallMessage(balanced, [topic], "steady", 8), "");
});

test("flow calibration keeps stretch sessions hard for high-skill Linux notes", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const allMediumBatch = Array.from({ length: 8 }, (_, index) =>
		makeLinuxMediumQuestion(`stretch-medium-${index}`)
	);
	const stretchGrade = [
		...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`stretch-hard-${index}`)),
		...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`stretch-replacement-medium-${index}`)),
	];

	assert.equal(shouldRequestChallengeTopUp(allMediumBatch, [topic], "stretch"), true);
	assert.match(
		challengeShortfallMessage(allMediumBatch, [topic], "stretch", 8),
		/Expected about 0 easy, 2 medium, 6 hard for that topic; got 0 easy, 8 medium, 0 hard/
	);

	const balanced = selectFlowBalancedQuestions(
		allMediumBatch,
		stretchGrade,
		8,
		[topic],
		"stretch"
	);

	assert.equal(balanced.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(balanced.filter((question) => question.difficulty === "medium").length, 2);
	assert.equal(challengeShortfallMessage(balanced, [topic], "stretch", 8), "");
});

test("flow calibration tightens the mix again for 90-plus Linux skill", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 92 });
	const softOldMix = [
		...Array.from({ length: 6 }, (_, index) => ({
			...makeLinuxHardQuestion(`skill-92-soft-hard-${index}`),
			sourceSubtopics: [`hard subtopic ${index}`],
		})),
		...Array.from({ length: 2 }, (_, index) => ({
			...makeLinuxMediumQuestion(`skill-92-soft-medium-${index}`),
			sourceSubtopics: [`medium subtopic ${index}`],
		})),
	];
	const targetMix = [
		...Array.from({ length: 7 }, (_, index) => ({
			...makeLinuxHardQuestion(`skill-92-target-hard-${index}`),
			sourceSubtopics: [`target hard subtopic ${index}`],
		})),
		{
			...makeLinuxMediumQuestion("skill-92-target-medium"),
			sourceSubtopics: ["target medium subtopic"],
		},
	];

	assert.deepEqual(desiredDifficultyCounts(8, topic.skill, "steady"), {
		easy: 0,
		medium: 1,
		hard: 7,
	});
	assert.equal(shouldRequestChallengeTopUp(softOldMix, [topic], "steady"), true);
	assert.match(
		challengeShortfallMessage(softOldMix, [topic], "steady", 8),
		/high-skill topic "Linux Commands".*Expected about 0 easy, 1 medium, 7 hard for that topic; got 0 easy, 2 medium, 6 hard/
	);
	assert.equal(challengeShortfallMessage(targetMix, [topic], "steady", 8), "");
});

test("flow calibration requires deep shell hard questions for 90-plus Linux skill", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 92 });
	const weakHardBatch = [
		...Array.from({ length: 7 }, (_, index) => ({
			...makeLinuxWeakHardQuestion(`skill-92-weak-hard-${index}`),
			sourceSubtopics: [`weak hard subtopic ${index}`],
		})),
		{
			...makeLinuxMediumQuestion("skill-92-weak-medium"),
			sourceSubtopics: ["weak medium subtopic"],
		},
	];
	const deepCandidates = Array.from({ length: 7 }, (_, index) => ({
		...makeLinuxHardQuestion(`skill-92-deep-hard-${index}`),
		sourceSubtopics: [`deep hard subtopic ${index}`],
	}));

	assert.equal(isDeepHardQuestion(makeLinuxWeakHardQuestion("weak-hard-probe")), false);
	assert.equal(isDeepHardQuestion(makeLinuxHardQuestion("deep-hard-probe")), true);
	assert.equal(shouldRequestChallengeTopUp(weakHardBatch, [topic], "steady"), true);
	assert.match(
		challengeShortfallMessage(weakHardBatch, [topic], "steady", 8),
		/high-skill topic "Linux Commands".*Expected about 0 easy, 1 medium, 7 hard for that topic; got 0 easy, 8 medium, 0 hard/
	);

	const balanced = selectFlowBalancedQuestions(
		weakHardBatch,
		deepCandidates,
		8,
		[topic],
		"steady"
	);

	assert.equal(
		balanced.filter((question) => question.id.startsWith("skill-92-weak-hard")).length,
		0
	);
	assert.equal(
		balanced.filter((question) => question.id.startsWith("skill-92-deep-hard")).length,
		7
	);
	assert.equal(challengeShortfallMessage(balanced, [topic], "steady", 8), "");
});

test("flow calibration keeps high-skill warmup sessions non-trivial", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const easyWarmup = Array.from({ length: 8 }, (_, index) =>
		makeLinuxRecallQuestion(`warmup-easy-${index}`)
	);
	const targetWarmup = [
		...Array.from({ length: 4 }, (_, index) =>
			makeLinuxHardQuestion(`warmup-hard-${index}`)
		),
		...Array.from({ length: 4 }, (_, index) =>
			makeLinuxMediumQuestion(`warmup-medium-${index}`)
		),
	];

	assert.deepEqual(desiredDifficultyCounts(8, topic.skill, "warmup"), {
		easy: 0,
		medium: 4,
		hard: 4,
	});
	assert.equal(isStrictChallengeSession([topic], "warmup"), true);
	assert.equal(shouldRequestChallengeTopUp(easyWarmup, [topic], "warmup"), true);
	assert.match(
		challengeShortfallMessage(easyWarmup, [topic], "warmup", 8),
		/high-skill topic "Linux Commands".*Expected about 0 easy, 4 medium, 4 hard for that topic; got 8 easy, 0 medium, 0 hard/
	);
	assert.equal(challengeShortfallMessage(targetWarmup, [topic], "warmup", 8), "");
});

test("flow calibration requires a hard question even for one high-skill Linux slot", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const oneMedium = [makeLinuxMediumQuestion("single-medium")];

	assert.match(
		challengeShortfallMessage(oneMedium, [topic], "steady", 1),
		/Expected about 0 easy, 0 medium, 1 hard for that topic; got 0 easy, 1 medium, 0 hard/
	);

	const balanced = selectFlowBalancedQuestions(
		oneMedium,
		[makeLinuxHardQuestion("single-hard")],
		1,
		[topic],
		"steady"
	);

	assert.equal(balanced.length, 1);
	assert.equal(balanced[0]?.difficulty, "hard");
	assert.equal(challengeShortfallMessage(balanced, [topic], "steady", 1), "");
});

test("flow calibration rejects repetitive high-skill Linux subtopics", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const repeatedFind = Array.from({ length: 8 }, (_, index) =>
		makeRepeatedLinuxFindHardQuestion(`repeated-find-${index}`)
	);
	const diverseCandidates = [
		{
			...makeLinuxHardQuestion("diverse-redirection-1"),
			sourceSubtopics: ["redirection order", "stdout", "stderr"],
		},
		{
			...makeLinuxHardQuestion("diverse-permissions-2"),
			sourceSubtopics: ["umask", "chmod", "creation modes"],
		},
		{
			...makeLinuxHardQuestion("diverse-signals-3"),
			sourceSubtopics: ["signals", "jobs", "SIGTERM vs SIGKILL"],
		},
	];

	assert.match(
		challengeShortfallMessage(repeatedFind, [topic], "steady", 8),
		/too repetitive.*at least 3 source subtopics; got 1/
	);

	const balanced = selectFlowBalancedQuestions(
		repeatedFind,
		diverseCandidates,
		8,
		[topic],
		"steady"
	);

	assert.equal(challengeShortfallMessage(balanced, [topic], "steady", 8), "");
	assert.ok(
		balanced.some((question) =>
			["redirection order", "umask", "signals"].some((subtopic) =>
				(question.sourceSubtopics ?? []).includes(subtopic)
			)
		)
	);
});

test("flow calibration rejects cosmetically varied hard Linux questions with one mechanic", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const repeatedMechanic = Array.from({ length: 8 }, (_, index) => ({
		...makeRepeatedLinuxFindHardQuestion(`cosmetic-find-${index}`),
		sourceSubtopics: [`cosmetic hard subtopic ${index}`],
	}));
	const diverseCandidates = [
		{
			...makeLinuxHardQuestion("cosmetic-redirection-repair-1"),
			sourceSubtopics: ["redirection order", "stdout", "stderr"],
		},
		{
			...makeLinuxHardQuestion("cosmetic-permissions-repair-2"),
			sourceSubtopics: ["umask", "chmod", "creation modes"],
		},
		{
			...makeLinuxHardQuestion("cosmetic-signals-repair-3"),
			sourceSubtopics: ["signals", "jobs", "SIGTERM vs SIGKILL"],
		},
	];

	assert.match(
		challengeShortfallMessage(repeatedMechanic, [topic], "steady", 8),
		/too narrow.*at least 2 distinct question setups; got 1/
	);

	const balanced = selectFlowBalancedQuestions(
		repeatedMechanic,
		diverseCandidates,
		8,
		[topic],
		"steady"
	);

	assert.equal(challengeShortfallMessage(balanced, [topic], "steady", 8), "");
	assert.ok(
		balanced.some((question) =>
			["redirection order", "umask", "signals"].some((subtopic) =>
				(question.sourceSubtopics ?? []).includes(subtopic)
			)
		)
	);
});

test("flow calibration protects high-skill topics inside mixed sessions", () => {
	const linux = makeTopic({
		path: "systems/Linux Commands.md",
		title: "Linux Commands",
		aliases: ["Shell practice"],
		skill: 83,
	});
	const novice = makeTopic({
		path: "networks/Intro Networks.md",
		title: "Intro Networks",
		skill: 35,
	});
	const weakMixedBatch = [
		makeLinuxRecallQuestion("linux-easy-one"),
		makeLinuxRecallQuestion("linux-easy-two"),
		makeLinuxHardQuestion("linux-hard-one"),
		makeQuestion({
			id: "network-medium-one",
			questionText: "Explain why DNS caching changes lookup latency.",
			correctAnswer: "Caching avoids repeated recursive lookups.",
			sourceTopics: ["Intro Networks"],
			difficulty: "medium",
		}),
		makeQuestion({
			id: "network-medium-two",
			questionText: "Trace how a TCP handshake establishes sequence state.",
			correctAnswer: "SYN, SYN-ACK, and ACK agree on starting sequence numbers.",
			sourceTopics: ["Intro Networks"],
			difficulty: "medium",
		}),
		makeQuestion({
			id: "network-hard-one",
			questionText: "Given packet loss after the first RTT, diagnose which TCP timer fires and how the congestion window changes.",
			correctAnswer: "The retransmission timer fires and congestion control backs off.",
			sourceTopics: ["Intro Networks"],
			difficulty: "hard",
		}),
		makeQuestion({
			id: "network-easy-one",
			questionText: "What does DNS stand for?",
			correctAnswer: "Domain Name System.",
			sourceTopics: ["Intro Networks"],
			difficulty: "easy",
		}),
		makeQuestion({
			id: "network-easy-two",
			questionText: "What command checks basic reachability?",
			correctAnswer: "ping",
			sourceTopics: ["Intro Networks"],
			difficulty: "easy",
		}),
	];
	const replacementGradeLinux = [
		...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`linux-repair-hard-${index}`)),
		...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`linux-repair-medium-${index}`)),
	];

	assert.equal(isStrictChallengeSession([linux, novice], "steady"), true);
	assert.equal(shouldRequestChallengeTopUp(weakMixedBatch, [linux, novice], "steady"), true);
	assert.match(
		challengeShortfallMessage(weakMixedBatch, [linux, novice], "steady", 8),
		/high-skill topic "Linux Commands".*got 2 easy, 0 medium, 1 hard/
	);

	const balanced = selectFlowBalancedQuestions(
		weakMixedBatch,
		replacementGradeLinux,
		8,
		[linux, novice],
		"steady"
	);
	assert.equal(
		balanced.some((question) => question.id.startsWith("linux-easy")),
		false
	);
	assert.equal(challengeShortfallMessage(balanced, [linux, novice], "steady", 8), "");
});

test("flow calibration requires coverage for selected high-skill topics", () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 83 });
	const novice = makeTopic({ title: "Intro Networks", skill: 25 });
	const networkOnly = [
		...Array.from({ length: 8 }, (_, index) => makeNetworkHardQuestion(`network-hard-${index}`)),
	];
	const linuxCandidates = [
		makeLinuxHardQuestion("linux-coverage-hard"),
		makeLinuxMediumQuestion("linux-coverage-medium"),
	];

	assert.match(
		challengeShortfallMessage(networkOnly, [linux, novice], "steady", 8),
		/did not cover high-skill topic "Linux Commands"/
	);

	const balanced = selectFlowBalancedQuestions(
		networkOnly,
		linuxCandidates,
		8,
		[linux, novice],
		"steady"
	);

	assert.equal(
		balanced.filter((question) => question.sourceTopics.includes("Linux Commands")).length,
		2
	);
	assert.equal(challengeShortfallMessage(balanced, [linux, novice], "steady", 8), "");
});

test("flow calibration protects high-skill topics even when topics exceed question count", () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 92 });
	const overflowTopics = [
		linux,
		...Array.from({ length: 10 }, (_, index) =>
			makeTopic({
				title: `Overflow topic ${index}`,
				path: `overflow/topic-${index}.md`,
				skill: 25,
			})
		),
	];
	const noLinux = Array.from({ length: 8 }, (_, index) =>
		makeNetworkHardQuestion(`overflow-network-${index}`)
	);

	assert.match(
		challengeShortfallMessage(noLinux, overflowTopics, "steady", 8),
		/did not cover high-skill topic "Linux Commands"/
	);

	const balanced = selectFlowBalancedQuestions(
		noLinux,
		[makeLinuxHardQuestion("overflow-linux-hard")],
		8,
		overflowTopics,
		"steady"
	);

	assert.equal(
		balanced.some((question) => question.id === "overflow-linux-hard"),
		true
	);
	assert.equal(challengeShortfallMessage(balanced, overflowTopics, "steady", 8), "");
});

test("flow calibration upgrades token medium Linux coverage for 90-plus mixed sessions", () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 92 });
	const overflowTopics = [
		linux,
		...Array.from({ length: 10 }, (_, index) =>
			makeTopic({
				title: `Overflow topic ${index}`,
				path: `overflow/topic-${index}.md`,
				skill: 25,
			})
		),
	];
	const tokenMedium = [
		{
			...makeLinuxMediumQuestion("overflow-linux-medium"),
			sourceSubtopics: ["token medium Linux coverage"],
		},
		...Array.from({ length: 7 }, (_, index) =>
			makeNetworkHardQuestion(`overflow-network-medium-${index}`)
		),
	];

	assert.match(
		challengeShortfallMessage(tokenMedium, overflowTopics, "steady", 8),
		/Expected about 0 easy, 0 medium, 1 hard for that topic; got 0 easy, 1 medium, 0 hard/
	);

	const balanced = selectFlowBalancedQuestions(
		tokenMedium,
		[makeLinuxHardQuestion("overflow-linux-upgrade-hard")],
		8,
		overflowTopics,
		"steady"
	);

	assert.equal(
		balanced.some((question) => question.id === "overflow-linux-upgrade-hard"),
		true
	);
	assert.equal(
		balanced.some((question) => question.id === "overflow-linux-medium"),
		false
	);
	assert.equal(challengeShortfallMessage(balanced, overflowTopics, "steady", 8), "");
});

test("flow calibration rejects token high-skill Linux coverage in mixed sessions", () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 83 });
	const novice = makeTopic({ title: "Intro Networks", skill: 25 });
	const tokenCoverage = [
		makeLinuxHardQuestion("linux-token-hard"),
		...Array.from({ length: 7 }, (_, index) => makeNetworkHardQuestion(`network-hard-${index}`)),
	];

	assert.match(
		challengeShortfallMessage(tokenCoverage, [linux, novice], "steady", 8),
		/barely covered high-skill topic "Linux Commands".*Expected at least 2 questions/
	);

	const balanced = selectFlowBalancedQuestions(
		tokenCoverage,
		[makeLinuxHardQuestion("linux-additional-hard")],
		8,
		[linux, novice],
		"steady"
	);

	assert.equal(
		balanced.filter((question) => question.sourceTopics.includes("Linux Commands")).length,
		2
	);
	assert.equal(challengeShortfallMessage(balanced, [linux, novice], "steady", 8), "");
});

test("session generation retries twice before accepting high-skill Linux challenge", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const batches = [
		Array.from({ length: 8 }, (_, index) => makeLinuxRecallQuestion(`easy-${index}`)),
		Array.from({ length: 8 }, (_, index) => makeLinuxMediumQuestion(`medium-${index}`)),
		[
			...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`hard-${index}`)),
			...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`replacement-medium-${index}`)),
		],
	];
	const client = makeBatchClient(batches);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 3);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.match(client.calls[2]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(questions.length, 8);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(questions.filter((question) => question.difficulty === "medium").length, 2);
	assert.equal(questions.filter((question) => question.difficulty === "easy").length, 0);
});

test("session generation repairs weak-hard Linux output for 90-plus skill", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 92 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) =>
			makeLinuxWeakHardQuestion(`initial-weak-hard-${index}`)
		),
		[
			...Array.from({ length: 7 }, (_, index) =>
				makeLinuxHardQuestion(`deep-repair-hard-${index}`)
			),
			makeLinuxMediumQuestion("deep-repair-medium"),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.some((question) => question.id.startsWith("initial-weak-hard")),
		false
	);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, 7);
	assert.equal(challengeShortfallMessage(questions, [topic], "steady", 8), "");
});

test("session generation repairs mixed sessions when the high-skill Linux topic is too easy", async () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 83 });
	const novice = makeTopic({ title: "Intro Networks", skill: 25 });
	const config: SessionConfig = {
		topics: [linux, novice],
		questionCount: 8,
		challengeMode: "steady",
		challengeReason: "mixed high-skill topic regression",
	};
	const topicContexts = [
		makeLinuxTopicContext(linux),
		makeTopicContext(
			novice,
			"DNS caches recursive lookup results. TCP handshakes establish sequence state before application data flows."
		),
	];
	const client = makeBatchClient([
		[
			makeLinuxRecallQuestion("linux-easy-one"),
			makeLinuxRecallQuestion("linux-easy-two"),
			makeLinuxHardQuestion("linux-hard-one"),
			makeQuestion({
				id: "network-medium-one",
				questionText: "Explain why DNS caching changes lookup latency.",
				correctAnswer: "Caching avoids repeated recursive lookups.",
				sourceTopics: ["Intro Networks"],
				difficulty: "medium",
			}),
			makeQuestion({
				id: "network-medium-two",
				questionText: "Trace how a TCP handshake establishes sequence state.",
				correctAnswer: "SYN, SYN-ACK, and ACK agree on starting sequence numbers.",
				sourceTopics: ["Intro Networks"],
				difficulty: "medium",
			}),
			makeQuestion({
				id: "network-medium-three",
				questionText: "Explain why retransmission timeout is more expensive than a duplicate-ACK fast retransmit.",
				correctAnswer: "Timeout loses stronger delivery evidence and resets the congestion window more severely.",
				sourceTopics: ["Intro Networks"],
				difficulty: "medium",
			}),
			makeQuestion({
				id: "network-medium-four",
				questionText: "Predict which cache is checked first for a repeated hostname lookup.",
				correctAnswer: "The local resolver or OS cache is checked before recursive lookup.",
				sourceTopics: ["Intro Networks"],
				difficulty: "medium",
			}),
			makeQuestion({
				id: "network-easy-one",
				questionText: "What does DNS stand for?",
				correctAnswer: "Domain Name System.",
				sourceTopics: ["Intro Networks"],
				difficulty: "easy",
			}),
		],
		[
			...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`repair-hard-${index}`)),
			...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`repair-medium-${index}`)),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 mixed questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(questions.length, 8);
	assert.equal(
		questions.some((question) => question.id.startsWith("linux-easy")),
		false
	);
	assert.equal(challengeShortfallMessage(questions, [linux, novice], "steady", 8), "");
});

test("session generation repairs token high-skill Linux coverage in mixed sessions", async () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 83 });
	const novice = makeTopic({ title: "Intro Networks", skill: 25 });
	const config: SessionConfig = {
		topics: [linux, novice],
		questionCount: 8,
		challengeMode: "steady",
		challengeReason: "token high-skill topic coverage regression",
	};
	const topicContexts = [
		makeLinuxTopicContext(linux),
		makeTopicContext(
			novice,
			"TCP loss recovery has different paths for duplicate ACKs and retransmission timeouts."
		),
	];
	const client = makeBatchClient([
		[
			makeLinuxHardQuestion("linux-token-hard"),
			...Array.from({ length: 7 }, (_, index) => makeNetworkHardQuestion(`network-hard-${index}`)),
		],
		[
			makeLinuxHardQuestion("linux-repair-hard"),
			makeLinuxMediumQuestion("linux-repair-medium"),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 mixed questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.filter((question) => question.sourceTopics.includes("Linux Commands")).length,
		2
	);
	assert.equal(challengeShortfallMessage(questions, [linux, novice], "steady", 8), "");
});

test("session generation repairs batches that ignore a selected high-skill Linux topic", async () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 83 });
	const novice = makeTopic({ title: "Intro Networks", skill: 25 });
	const config: SessionConfig = {
		topics: [linux, novice],
		questionCount: 8,
		challengeMode: "steady",
		challengeReason: "selected high-skill topic coverage regression",
	};
	const topicContexts = [
		makeLinuxTopicContext(linux),
		makeTopicContext(
			novice,
			"DNS maps hostnames to addresses. TCP congestion control reacts to loss and acknowledgements."
		),
	];
	const client = makeBatchClient([
		[
			...Array.from({ length: 8 }, (_, index) => makeNetworkHardQuestion(`network-hard-${index}`)),
		],
		[
			makeLinuxHardQuestion("linux-coverage-hard"),
			makeLinuxMediumQuestion("linux-coverage-medium"),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 mixed questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.some((question) => question.sourceTopics.includes("Linux Commands")),
		true
	);
	assert.equal(challengeShortfallMessage(questions, [linux, novice], "steady", 8), "");
});

test("session generation treats fake-medium Linux recall as too easy for skill 83", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) => makeLinuxFakeMediumRecallQuestion(`fake-medium-${index}`)),
		[
			...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`repair-hard-${index}`)),
			...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`repair-medium-${index}`)),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.some((question) => question.id.startsWith("fake-medium")),
		false
	);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(questions.filter((question) => question.difficulty === "medium").length, 2);
});

test("session generation treats simple Linux predictions as easy for skill 83", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) =>
			makeLinuxSimplePredictionQuestion(`initial-simple-prediction-${index}`)
		),
		[
			...Array.from({ length: 6 }, (_, index) =>
				makeLinuxHardQuestion(`repair-simple-prediction-hard-${index}`)
			),
			...Array.from({ length: 2 }, (_, index) =>
				makeLinuxMediumQuestion(`repair-simple-prediction-medium-${index}`)
			),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.some((question) => question.id.startsWith("initial-simple-prediction")),
		false
	);
	assert.equal(questions.filter((question) => question.difficulty === "easy").length, 0);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(questions.filter((question) => question.difficulty === "medium").length, 2);
});

test("session generation treats basic-section Linux questions as easy for skill 83", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) =>
			makeLinuxBasicSectionQuestion(`initial-basic-linux-${index}`)
		),
		[
			...Array.from({ length: 6 }, (_, index) =>
				makeLinuxHardQuestion(`basic-linux-repair-hard-${index}`)
			),
			...Array.from({ length: 2 }, (_, index) =>
				makeLinuxMediumQuestion(`basic-linux-repair-medium-${index}`)
			),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.some((question) => question.id.startsWith("initial-basic-linux")),
		false
	);
	assert.equal(questions.filter((question) => question.difficulty === "easy").length, 0);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(questions.filter((question) => question.difficulty === "medium").length, 2);
});

test("session generation repairs repetitive hard Linux subtopics for skill 83", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) =>
			makeRepeatedLinuxFindHardQuestion(`initial-repeated-find-${index}`)
		),
		[
			{
				...makeLinuxHardQuestion("repair-redirection-1"),
				sourceSubtopics: ["redirection order", "stdout", "stderr"],
			},
			{
				...makeLinuxHardQuestion("repair-permissions-2"),
				sourceSubtopics: ["umask", "chmod", "creation modes"],
			},
			{
				...makeLinuxHardQuestion("repair-signals-3"),
				sourceSubtopics: ["signals", "jobs", "SIGTERM vs SIGKILL"],
			},
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(challengeShortfallMessage(questions, [topic], "steady", 8), "");
	assert.ok(
		questions.some((question) =>
			(question.sourceSubtopics ?? []).includes("redirection order")
		)
	);
	assert.ok(
		questions.some((question) =>
			(question.sourceSubtopics ?? []).includes("umask")
		)
	);
});

test("session generation keeps hard surplus from a weak-first high-skill Linux response", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		[
			...Array.from({ length: 8 }, (_, index) => makeLinuxFakeMediumRecallQuestion(`surplus-fake-${index}`)),
			...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`surplus-hard-${index}`)),
			...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`surplus-medium-${index}`)),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 1);
	assert.equal(
		questions.some((question) => question.id.startsWith("surplus-fake")),
		false
	);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(questions.filter((question) => question.difficulty === "medium").length, 2);
});

test("session generation rejects repeated fake-medium Linux retries for skill 83", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) => makeLinuxFakeMediumRecallQuestion(`initial-fake-${index}`)),
		Array.from({ length: 8 }, (_, index) => makeLinuxFakeMediumRecallQuestion(`retry-one-fake-${index}`)),
		Array.from({ length: 8 }, (_, index) => makeLinuxFakeMediumRecallQuestion(`retry-two-fake-${index}`)),
	]);

	await assert.rejects(
		() =>
			generateQuestionsFromClient(
				client,
				{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
				config,
				topicContexts
			),
		/Failed to generate questions: Generated questions for high-skill topic "Linux Commands" are still too easy/
	);
	assert.equal(client.calls.length, 3);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.match(client.calls[1]?.textPrompt ?? "", /Under-challenging stems to avoid duplicating:\n1\. \[easy\]/);
});

test("session generation treats command-choice Linux fake-hard questions as too easy for skill 83", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) => makeLinuxFakeHardOptionQuestion(`initial-fake-hard-${index}`)),
		[
			...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`repair-hard-${index}`)),
			...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`repair-medium-${index}`)),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.some((question) => question.id.startsWith("initial-fake-hard")),
		false
	);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(questions.filter((question) => question.difficulty === "medium").length, 2);
});

test("session generation treats shallow Linux comparison questions as too easy for skill 83", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) =>
			makeLinuxWeakHardQuestion(`initial-shallow-compare-${index}`)
		),
		[
			...Array.from({ length: 6 }, (_, index) =>
				makeLinuxHardQuestion(`shallow-compare-repair-hard-${index}`)
			),
			...Array.from({ length: 2 }, (_, index) =>
				makeLinuxMediumQuestion(`shallow-compare-repair-medium-${index}`)
			),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.some((question) => question.id.startsWith("initial-shallow-compare")),
		false
	);
	assert.equal(questions.filter((question) => question.difficulty === "easy").length, 0);
	assert.ok(questions.filter((question) => question.difficulty === "hard").length >= 6);
	assert.equal(challengeShortfallMessage(questions, [topic], "steady", 8), "");
});

test("session generation accepts note-alias source labels for high-skill coverage", async () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 83, aliases: ["Shell"] });
	const novice = makeTopic({ title: "Intro Networks", skill: 25 });
	const config: SessionConfig = {
		topics: [linux, novice],
		questionCount: 8,
		challengeMode: "steady",
		challengeReason: "shell source alias regression",
	};
	const topicContexts = [
		makeLinuxTopicContext(linux),
		makeTopicContext(novice, "DNS maps hostnames to IP addresses."),
	];
	const shellSourced = [
		...Array.from({ length: 6 }, (_, index) => ({
			...makeLinuxHardQuestion(`shell-alias-hard-${index}`),
			sourceTopics: ["Shell"],
		})),
		...Array.from({ length: 2 }, (_, index) => ({
			...makeLinuxMediumQuestion(`shell-alias-medium-${index}`),
			sourceTopics: ["Shell"],
		})),
	];
	const client = makeBatchClient([shellSourced]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 mixed questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 1);
	assert.equal(
		questions.every((question) => question.sourceTopics.includes("Linux Commands")),
		true
	);
	assert.equal(challengeShortfallMessage(questions, [linux, novice], "steady", 8), "");
});

test("session generation rejects repeated under-challenge for high-skill Linux notes", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) => makeLinuxRecallQuestion(`easy-${index}`)),
		Array.from({ length: 8 }, (_, index) => makeLinuxMediumQuestion(`medium-${index}`)),
		Array.from({ length: 8 }, (_, index) => makeLinuxMediumQuestion(`still-medium-${index}`)),
	]);

	await assert.rejects(
		() =>
			generateQuestionsFromClient(
				client,
				{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
				config,
				topicContexts
			),
		/Failed to generate questions: Generated questions for high-skill topic "Linux Commands" are still too easy/
	);
	assert.equal(client.calls.length, 3);
});

test("session generation repairs underfilled high-skill Linux batches with challenge top-up", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 3 }, (_, index) => makeLinuxHardQuestion(`initial-hard-${index}`)),
		Array.from({ length: 5 }, (_, index) => makeLinuxMediumQuestion(`generic-medium-${index}`)),
		[
			...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`repair-hard-${index}`)),
			...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`repair-medium-${index}`)),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
		config,
		topicContexts
	);

	assert.equal(client.calls.length, 3);
	assert.match(client.calls[1]?.textPrompt ?? "", /Retry correction/);
	assert.match(client.calls[2]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(questions.length, 8);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(questions.filter((question) => question.difficulty === "medium").length, 2);
	assert.equal(questions.filter((question) => question.difficulty === "easy").length, 0);
});

test("session generation rejects underfilled high-skill batches that remain too medium-heavy", async () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const config = makeLinuxSessionConfig(topic);
	const topicContexts = [makeLinuxTopicContext(topic)];
	const client = makeBatchClient([
		Array.from({ length: 3 }, (_, index) => makeLinuxHardQuestion(`initial-hard-${index}`)),
		Array.from({ length: 5 }, (_, index) => makeLinuxMediumQuestion(`generic-medium-${index}`)),
		Array.from({ length: 5 }, (_, index) => makeLinuxMediumQuestion(`repair-one-medium-${index}`)),
		Array.from({ length: 5 }, (_, index) => makeLinuxMediumQuestion(`repair-two-medium-${index}`)),
	]);

	await assert.rejects(
		() =>
			generateQuestionsFromClient(
				client,
				{ textPrompt: "Generate exactly 8 questions.", attachments: [] },
				config,
				topicContexts
			),
		/Failed to generate questions: Generated questions for high-skill topic "Linux Commands" are still too easy/
	);
	assert.equal(client.calls.length, 4);
	assert.match(client.calls[1]?.textPrompt ?? "", /Retry correction/);
	assert.match(client.calls[2]?.textPrompt ?? "", /Challenge correction/);
	assert.match(client.calls[3]?.textPrompt ?? "", /Challenge correction/);
});

test("flow calibration sequences balanced batches as a ramp instead of an easy block", () => {
	const topic = makeTopic({ skill: 70 });
	const questions = [
		...Array.from({ length: 4 }, (_, index) =>
			makeQuestion({
				id: `easy-${index}`,
				questionText: `Easy recall ${index}`,
				correctAnswer: `easy ${index}`,
				options: [`easy ${index}`, "B", "C", "D"],
				difficulty: "easy",
			})
		),
		...Array.from({ length: 2 }, (_, index) =>
			makeQuestion({
				id: `medium-${index}`,
				questionText: `Medium trace ${index}`,
				correctAnswer: `medium ${index}`,
				options: [`medium ${index}`, "B", "C", "D"],
				difficulty: "medium",
			})
		),
		...Array.from({ length: 2 }, (_, index) =>
			makeQuestion({
				id: `hard-${index}`,
				questionText: `Hard transfer ${index}`,
				correctAnswer: `hard ${index}`,
				options: [`hard ${index}`, "B", "C", "D"],
				difficulty: "hard",
			})
		),
	];

	const sequenced = selectFlowBalancedQuestions(
		questions,
		[],
		questions.length,
		[topic],
		"steady"
	);
	const earlyDifficulties = sequenced
		.slice(0, 4)
		.map((question) => question.difficulty);

	assert.deepEqual(earlyDifficulties.slice(0, 3), ["easy", "medium", "hard"]);
	assert.ok(earlyDifficulties.filter((difficulty) => difficulty === "easy").length <= 2);
});

test("session preparation flow-orders a complete first provider batch", () => {
	const topic = makeTopic({ skill: 70 });
	const rawBatch = [
		...Array.from({ length: 3 }, (_, index) =>
			makeQuestion({
				id: `easy-first-${index}`,
				questionText: `Easy first ${index}`,
				correctAnswer: `easy first ${index}`,
				options: [`easy first ${index}`, "B", "C", "D"],
				difficulty: "easy",
			})
		),
		makeQuestion({
			id: "medium-later",
			questionText: "Medium later",
			correctAnswer: "medium later",
			options: ["medium later", "B", "C", "D"],
			difficulty: "medium",
		}),
		makeQuestion({
			id: "hard-later",
			questionText: "Hard later",
			correctAnswer: "hard later",
			options: ["hard later", "B", "C", "D"],
			difficulty: "hard",
		}),
	];

	const prepared = prepareGeneratedQuestionsForSession(rawBatch, {
		questionCount: rawBatch.length,
		topics: [topic],
		challengeMode: "steady",
	});

	assert.deepEqual(
		prepared.slice(0, 3).map((question) => question.difficulty),
		["easy", "medium", "hard"]
	);
});

test("session preparation preserves harder surplus candidates for high-skill topics", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const rawBatch = [
		...Array.from({ length: 8 }, (_, index) => makeLinuxRecallQuestion(`surplus-easy-${index}`)),
		...Array.from({ length: 6 }, (_, index) => makeLinuxHardQuestion(`surplus-hard-${index}`)),
		...Array.from({ length: 2 }, (_, index) => makeLinuxMediumQuestion(`surplus-medium-${index}`)),
	];

	const prepared = prepareGeneratedQuestionsForSession(rawBatch, {
		questionCount: 8,
		topics: [topic],
		challengeMode: "steady",
	});

	assert.equal(prepared.some((question) => question.id.startsWith("surplus-easy")), false);
	assert.equal(prepared.filter((question) => question.difficulty === "hard").length, 6);
	assert.equal(prepared.filter((question) => question.difficulty === "medium").length, 2);
});

test("flow navigation pulls harder questions forward after fluent correct answers", () => {
	const questions = [
		makeQuestion({ id: "q1", difficulty: "easy" }),
		makeQuestion({ id: "q2", difficulty: "easy" }),
		makeQuestion({ id: "q3", difficulty: "medium" }),
		makeQuestion({ id: "q4", difficulty: "hard" }),
	];
	const results = [
		makeResult(questions[0]!, { timeTakenMs: 20_000 }),
		makeResult(questions[1]!, { timeTakenMs: 20_000 }),
	];

	assert.equal(nextTargetDifficulty(results), "hard");
	adaptQuestionOrderForFlow(questions, results, 1);
	assert.equal(questions[2]?.difficulty, "hard");
});

test("flow navigation steps up after a slow correct easy answer", () => {
	const questions = [
		makeQuestion({ id: "q1", difficulty: "easy" }),
		makeQuestion({ id: "q2", difficulty: "easy" }),
		makeQuestion({ id: "q3", difficulty: "medium" }),
		makeQuestion({ id: "q4", difficulty: "hard" }),
	];
	const results = [
		makeResult(questions[0]!, { timeTakenMs: 70_000 }),
	];

	assert.equal(nextTargetDifficulty(results), "medium");
	adaptQuestionOrderForFlow(questions, results, 0);
	assert.equal(questions[1]?.difficulty, "medium");
});

test("flow navigation escalates after repeated correct medium answers", () => {
	const questions = [
		makeQuestion({ id: "q1", difficulty: "medium" }),
		makeQuestion({ id: "q2", difficulty: "medium" }),
		makeQuestion({ id: "q3", difficulty: "medium" }),
		makeQuestion({ id: "q4", difficulty: "hard" }),
	];
	const results = [
		makeResult(questions[0]!, { timeTakenMs: 120_000 }),
		makeResult(questions[1]!, { timeTakenMs: 130_000 }),
	];

	assert.equal(nextTargetDifficulty(results), "hard");
	adaptQuestionOrderForFlow(questions, results, 1);
	assert.equal(questions[2]?.difficulty, "hard");
});

test("flow navigation recovers to an easy question after a miss", () => {
	const questions = [
		makeQuestion({ id: "q1", difficulty: "medium" }),
		makeQuestion({ id: "q2", difficulty: "hard" }),
		makeQuestion({ id: "q3", difficulty: "easy" }),
	];
	const results = [
		makeResult(questions[0]!, {
			isCorrect: false,
			userAnswer: "wrong",
			timeTakenMs: 70_000,
		}),
	];

	assert.equal(nextTargetDifficulty(results), "easy");
	adaptQuestionOrderForFlow(questions, results, 0);
	assert.equal(questions[1]?.difficulty, "easy");
});

test("question calibration filters title-framed recall without a concept anchor", () => {
	const topic = makeTopic({
		title: "Binary search overview",
	});
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Loop invariant", level: 2 }],
		sections: [
			{
				heading: "Loop invariant",
				level: 2,
				content: "The target remains inside the closed interval when updates preserve the invariant.",
				wordCount: 12,
			},
		],
	});
	const calibrated = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "In the Binary search overview note, what does it do?",
				correctAnswer: "It halves the search space.",
				options: [
					"It halves the search space.",
					"It sorts the array.",
					"It scans every element.",
					"It builds a heap.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: [],
				difficulty: "medium",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.equal(calibrated.length, 0);
});

test("question calibration filters named problem questions that require title memory", () => {
	const topic = makeTopic({
		title: "Koko Eating Bananas",
		aliases: ["Koko banana piles"],
	});
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Feasibility check", level: 2 }],
		sections: [
			{
				heading: "Feasibility check",
				level: 2,
				content: "For each speed k, sum ceil(pile / k) across piles and compare to h.",
				wordCount: 15,
			},
		],
	});
	const calibrated = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "The binary search approach for Koko Eating Bananas has time complexity O(log(max) × N). What does the O(N) factor represent?",
				correctAnswer: "Evaluating feasibility by summing ceil(pile/k) across all piles.",
				options: [
					"Sorting the piles.",
					"Evaluating feasibility by summing ceil(pile/k) across all piles.",
					"The number of binary-search iterations.",
					"Finding the maximum pile only.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: ["Feasibility check"],
				difficulty: "medium",
			}),
			makeQuestion({
				questionText: "Given piles of bananas and h hours, Koko chooses an eating rate k and the feasibility check sums ceil(pile/k) across every pile. Why does that make each binary-search step O(N)?",
				correctAnswer: "Because one feasibility test scans all N piles.",
				options: [
					"Because one feasibility test scans all N piles.",
					"Because the piles must be sorted each step.",
					"Because there are N candidate speeds.",
					"Because max(pile) is recomputed N times.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: ["Feasibility check"],
				difficulty: "medium",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.equal(calibrated.length, 1);
	assert.match(calibrated[0]?.questionText ?? "", /Given piles/);
});

test("question calibration rejects problem-title framing without the problem setup", () => {
	const topic = makeTopic({
		title: "Single Element in Sorted Array",
	});
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Index pairing invariant", level: 2 }],
		sections: [
			{
				heading: "Index pairing invariant",
				level: 2,
				content: "Before the single element, pairs start at even indices; after it, pairs start at odd indices.",
				wordCount: 15,
			},
		],
	});
	const calibrated = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "For the 'Single Element in Sorted Array' problem, the binary search approach relies on an index-pairing invariant. If mid is even and nums[mid] == nums[mid+1], where is the single element?",
				correctAnswer: "The single element is in the right half.",
				options: [
					"The single element is in the left half.",
					"The single element is in the right half.",
					"The single element is exactly at mid.",
					"More information is needed.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: ["Index pairing invariant"],
				difficulty: "medium",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.equal(calibrated.length, 0);
});

test("question calibration links accepted source title mentions to Obsidian wikilinks", () => {
	const topic = makeTopic({
		path: "Algorithms/First and Last Occurrence.md",
		title: "First and Last Occurrence",
	});
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Upper bound endpoint", level: 2 }],
		sections: [
			{
				heading: "Upper bound endpoint",
				level: 2,
				content: "The upper bound returns the first index strictly greater than the target.",
				wordCount: 12,
			},
		],
	});
	const [question] = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "Given nums = [1, 2, 2, 3] and target = 2, the **First and Last Occurrence** approach returns `upperBound - 1` for the last index. Why not return `upperBound` directly?",
				correctAnswer: "Because upperBound points to the first element greater than the target.",
				options: [
					"Because upperBound points to the first element greater than the target.",
					"Because arrays are zero-indexed.",
					"Because binary search always overshoots by one.",
					"Because the array is searched in reverse.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: ["Upper bound endpoint"],
				difficulty: "hard",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.ok(question);
	assert.match(
		question.questionText,
		/\[\[Algorithms\/First and Last Occurrence\|First and Last Occurrence\]\]/
	);
	assert.doesNotMatch(question.questionText, /\*\*First and Last Occurrence\*\*/);
});

test("question calibration rejects visual questions when no visual is included", () => {
	const topic = makeTopic({
		title: "Virtual memory",
	});
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Address translation", level: 2 }],
		sections: [
			{
				heading: "Address translation",
				level: 2,
				content: "Virtual addresses are translated to physical frames through page tables.",
				wordCount: 11,
			},
		],
	});
	const calibrated = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "According to the virtual memory diagram shown, what is the primary purpose of this mapping mechanism?",
				correctAnswer: "To translate process virtual addresses to physical memory frames.",
				options: [
					"To translate process virtual addresses to physical memory frames.",
					"To encrypt every memory address.",
					"To assign process IDs to RAM addresses.",
					"To cache CPU instructions.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: ["Address translation"],
				difficulty: "easy",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.equal(calibrated.length, 0);
});

test("question calibration infers source subtopics from note headings", () => {
	const topic = makeTopic({ title: "Binary search variants" });
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "First occurrence branch", level: 2 }],
		sections: [
			{
				heading: "First occurrence branch",
				level: 2,
				content: "Save mid and keep searching left.",
				wordCount: 6,
			},
		],
	});
	const [question] = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "When the first occurrence branch sees `nums[mid] == target`, what update preserves the candidate?",
				correctAnswer: "Save mid and set high = mid - 1.",
				options: [
					"Save mid and set high = mid - 1.",
					"Return mid immediately.",
					"Set low = mid + 1.",
					"Set high = mid.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: [],
				difficulty: "medium",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.ok(question);
	assert.deepEqual(question.sourceSubtopics, ["First occurrence branch"]);
	assert.equal(question.difficulty, "easy");
});

test("question calibration infers source subtopics from hidden body concepts", () => {
	const topic = makeTopic({ title: "Messy binary-search scratchpad" });
	const structure = makeStructure({
		title: topic.title,
		headings: [],
		sections: [
			{
				heading: "Body",
				level: 0,
				content: [
					"- **Monotonic predicate**: once the condition turns true, every later candidate stays true.",
					"Pivot boundary trap: using `low = mid` can stall when two values remain.",
				].join("\n"),
				wordCount: 22,
			},
		],
	});
	const [question] = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "Why does a binary search over a monotonic predicate move toward the first true index instead of stopping at the first true value it sees?",
				correctAnswer: "Because true values form a suffix, so the first true boundary can still be to the left.",
				options: [
					"Because true values form a suffix, so the first true boundary can still be to the left.",
					"Because every predicate must alternate true and false.",
					"Because binary search only works on arrays of numbers.",
					"Because stopping early gives the maximum true index.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: [],
				difficulty: "medium",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.ok(question);
	assert.deepEqual(question.sourceSubtopics, ["Monotonic predicate"]);
});

test("question calibration treats aliases as topic labels, not subtopics", () => {
	const topic = makeTopic({
		title: "Rotated sorted array invariants",
		aliases: ["Binary search rotation"],
	});
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Pivot boundary", level: 2 }],
		sections: [
			{
				heading: "Pivot boundary",
				level: 2,
				content: "The minimum stays across the unsorted boundary.",
				wordCount: 8,
			},
		],
	});
	const [question] = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "When binary search rotation finds the unsorted boundary, which side can still contain the minimum?",
				correctAnswer: "The side crossing the pivot boundary.",
				options: [
					"The side crossing the pivot boundary.",
					"Always the left half.",
					"Always the right half.",
					"The side with more elements.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: ["Binary search rotation", "Binary search rotation overview", "Pivot boundary"],
				difficulty: "medium",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.ok(question);
	assert.deepEqual(question.sourceSubtopics, ["Pivot boundary"]);
});

test("question calibration canonicalizes alias-prefixed concept subtopics", () => {
	const topic = makeTopic({
		title: "Rotated sorted array invariants",
		aliases: ["Binary search rotation"],
	});
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Pivot boundary", level: 2 }],
		sections: [
			{
				heading: "Pivot boundary",
				level: 2,
				content: "The minimum stays across the unsorted boundary.",
				wordCount: 8,
			},
		],
	});
	const [question] = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "Why does binary search rotation pivot boundary logic discard the sorted half?",
				correctAnswer: "Because the pivot boundary keeps the minimum outside the discarded sorted half.",
				options: [
					"Because the pivot boundary keeps the minimum outside the discarded sorted half.",
					"Because duplicates are impossible.",
					"Because the target was found.",
					"Because every left half is unsorted.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: ["Binary search rotation pivot boundary"],
				difficulty: "medium",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.ok(question);
	assert.deepEqual(question.sourceSubtopics, ["Pivot boundary"]);
});

test("question calibration can infer subtopics when provider uses an alias source topic", () => {
	const topic = makeTopic({
		title: "Rotated sorted array invariants",
		aliases: ["Binary search rotation"],
	});
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Pivot boundary", level: 2 }],
		sections: [
			{
				heading: "Pivot boundary",
				level: 2,
				content: "The boundary condition chooses which sorted half can be discarded.",
				wordCount: 10,
			},
		],
	});
	const [question] = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText: "In the pivot boundary case, why is one sorted half discarded?",
				correctAnswer: "Because the minimum cannot be inside that sorted half except at the recorded candidate.",
				options: [
					"Because the minimum cannot be inside that sorted half except at the recorded candidate.",
					"Because binary search always discards the right half.",
					"Because the array is no longer sorted.",
					"Because the target was found.",
				],
				sourceTopics: ["Binary search rotation"],
				sourceSubtopics: [],
				difficulty: "medium",
			}),
		],
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		[topic]
	);

	assert.ok(question);
	assert.deepEqual(question.sourceSubtopics, ["Pivot boundary"]);
});

test("provider presets use documented current model IDs", () => {
	assert.equal(PROVIDER_PRESETS.gemini.model, "gemini-3.5-flash");
	assert.notEqual(PROVIDER_PRESETS.gemini.model, "gemini-2.0-flash");
	assert.equal(PROVIDER_PRESETS.anthropic.model, "claude-sonnet-4-6");
	assert.notEqual(PROVIDER_PRESETS.anthropic.model, "claude-sonnet-4-20250514");
	assert.equal(PROVIDER_PRESETS.openai.model, "gpt-5.5");
	assert.equal(PROVIDER_PRESETS.openai.baseUrl, "https://api.openai.com/v1/responses");
	assert.equal(PROVIDER_PRESETS.deepseek.model, "deepseek-v4-flash");
	assert.equal(PROVIDER_PRESETS.qwen.model, "qwen3.7-plus");
	assert.notEqual(PROVIDER_PRESETS.qwen.model, "qwen-plus");
	assert.equal(PROVIDER_PRESETS.openrouter.model, "openai/gpt-5.4-mini");
	assert.equal(PROVIDER_PRESETS.gemini.supportsPdfs, true);
	assert.equal(PROVIDER_PRESETS.anthropic.supportsPdfs, true);
	assert.equal(PROVIDER_PRESETS.openai.supportsPdfs, false);
	assert.equal(PROVIDER_PRESETS.openrouter.supportsPdfs, false);
});

test("README provider defaults stay in sync with presets", () => {
	const readme = readFileSync("README.md", "utf8");
	for (const preset of Object.values(PROVIDER_PRESETS)) {
		if (preset.model) {
			assert.ok(
				readme.includes(`\`${preset.model}\``),
				`README missing default model ${preset.model}`
			);
		}
		if (preset.baseUrl && !preset.baseUrl.includes("localhost")) {
			assert.ok(
				readme.includes(`\`${preset.baseUrl}\``),
				`README missing default endpoint ${preset.baseUrl}`
			);
		}
	}
});

test("provider model migration repairs stale saved defaults without changing custom models", () => {
	assert.equal(
		migrateProviderModel("anthropic", "claude-sonnet-4-20250514"),
		PROVIDER_PRESETS.anthropic.model
	);
	assert.equal(
		migrateProviderModel("deepseek", "deepseek-reasoner"),
		"deepseek-reasoner"
	);
	assert.equal(
		migrateProviderModel("qwen", "qwen-plus"),
		"qwen-plus"
	);
	assert.equal(
		migrateProviderModel("openai-compatible", "my-local-model"),
		"my-local-model"
	);
	assert.deepEqual(
		normalizeProviderModels({
			anthropic: "claude-sonnet-4-20250514",
			qwen: "qwen-plus",
			"openai-compatible": "local/teacher",
			unknown: "ignored",
		}),
		{
			qwen: "qwen-plus",
			"openai-compatible": "local/teacher",
		}
	);
	assert.equal(
		providerModelsNeedNormalization({ anthropic: "claude-sonnet-4-20250514" }),
		true
	);
	assert.equal(
		providerModelsNeedNormalization({ anthropic: PROVIDER_PRESETS.anthropic.model }),
		true
	);
	assert.equal(
		providerModelsNeedNormalization({ qwen: "qwen-plus" }),
		false
	);
});

test("provider model overrides are sparse and resettable", () => {
	const models: AdaptivePracticeSettings["providerModels"] = {};

	setProviderModelOverride(models, "anthropic", PROVIDER_PRESETS.anthropic.model);
	assert.deepEqual(models, {});

	setProviderModelOverride(models, "anthropic", "claude-sonnet-4-20250514");
	assert.deepEqual(models, {});

	setProviderModelOverride(models, "anthropic", "custom-claude-router");
	assert.deepEqual(models, { anthropic: "custom-claude-router" });

	setProviderModelOverride(models, "anthropic", "");
	assert.deepEqual(models, {});
});

test("OpenAI Responses adapter normalizes endpoint and extracts output text", () => {
	assert.equal(
		normalizeOpenAiResponsesUrl("https://api.openai.com/v1"),
		"https://api.openai.com/v1/responses"
	);
	assert.equal(
		normalizeOpenAiResponsesUrl("https://api.openai.com/v1/chat/completions"),
		"https://api.openai.com/v1/responses"
	);
	assert.equal(
		getOpenAiResponsesText({
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "{\"questions\":[]}",
						},
					],
				},
			],
		}),
		"{\"questions\":[]}"
	);
});

test("OpenAI Responses adapter builds structured-output request bodies", () => {
	const body = buildOpenAiResponsesBody(
		{
			textPrompt: "Generate questions.",
			attachments: [],
		},
		{
			baseUrl: PROVIDER_PRESETS.openai.baseUrl,
			model: PROVIDER_PRESETS.openai.model,
			jsonMode: "json_schema",
			supportsImages: true,
		}
	);
	const text = body["text"] as { format: Record<string, unknown> };

	assert.equal(body["model"], "gpt-5.5");
	assert.equal(body["max_output_tokens"], 8192);
	assert.equal("temperature" in body, false);
	assert.deepEqual(body["input"], [
		{
			role: "user",
			content: "Generate questions.",
		},
	]);
	assert.equal(text.format["type"], "json_schema");
	assert.equal(text.format["name"], "adaptive_practice_questions");
	assert.ok(text.format["schema"]);
});

test("provider errors include model and settings guidance", () => {
	const detail = extractProviderErrorDetail(JSON.stringify({
		error: {
			message: "model: claude-sonnet-4-20250514",
		},
	}));
	const message = formatProviderError({
		providerLabel: "Anthropic",
		status: 404,
		model: "claude-sonnet-4-20250514",
		detail,
	});

	assert.match(message, /Anthropic API error \(404\)/);
	assert.match(message, /claude-sonnet-4-20250514/);
	assert.match(message, /Check the model name in Settings/);
});

test("provider errors guide JSON mode changes for schema rejections", () => {
	const message = formatProviderError({
		providerLabel: "OpenAI-compatible",
		status: 400,
		model: "local-model",
		baseUrl: "http://localhost:1234/v1/chat/completions",
		detail: "response_format json_schema is not supported",
	});

	assert.match(message, /OpenAI-compatible API error \(400\)/);
	assert.match(message, /endpoint http:\/\/localhost:1234\/v1\/chat\/completions/);
	assert.match(message, /Try changing this provider's JSON mode/);

	const responsesMessage = formatProviderError({
		providerLabel: "OpenAI",
		status: 400,
		model: "gpt-5.5",
		baseUrl: "https://api.openai.com/v1/responses",
		detail: "Invalid value for text.format json_schema",
	});
	assert.match(responsesMessage, /Try changing this provider's JSON mode/);
});

test("provider secret names survive provider switches", () => {
	const settings: AdaptivePracticeSettings = {
		...DEFAULT_SETTINGS,
		providerSecretNames: {},
	};

	setProviderSecretName(settings, "gemini", "My Gemini Key");
	assert.equal(settings.secretName, "My Gemini Key");
	assert.equal(getProviderSecretId(settings), "my-gemini-key");

	settings.llmProvider = "anthropic";
	syncLegacySecretName(settings);
	assert.equal(getProviderSecretName(settings), "anthropic-api-key");
	assert.equal(getProviderSecretId(settings), "anthropic-api-key");

	setProviderSecretName(settings, "anthropic", "team anthropic");
	assert.equal(getProviderSecretId(settings), "team-anthropic");

	settings.llmProvider = "gemini";
	syncLegacySecretName(settings);
	assert.equal(getProviderSecretName(settings), "My Gemini Key");
	assert.equal(settings.providerSecretNames.anthropic, "team anthropic");
});

test("legacy secret migration avoids carrying a stale Gemini default to another provider", () => {
	assert.deepEqual(
		normalizeProviderSecretNames(undefined, "anthropic", "gemini-api-key"),
		{}
	);
	assert.deepEqual(
		normalizeProviderSecretNames(undefined, "anthropic", "my shared key"),
		{ anthropic: "my shared key" }
	);

	const settings: AdaptivePracticeSettings = {
		...DEFAULT_SETTINGS,
		llmProvider: "anthropic",
		secretName: "gemini-api-key",
		providerSecretNames: {},
	};
	assert.equal(getProviderSecretName(settings), "anthropic-api-key");
});

test("secret storage helpers fail closed when storage is missing or throws", () => {
	const secrets = new Map<string, string>();
	const app = {
		secretStorage: {
			getSecret: (id: string) => secrets.get(id) ?? null,
			setSecret: (id: string, value: string) => { secrets.set(id, value); },
		},
	};

	assert.equal(setSecretSafely(app, "adaptive-key", "secret"), true);
	assert.equal(getSecretSafely(app, "adaptive-key"), "secret");
	assert.equal(getSecretSafely({}, "adaptive-key"), null);
	assert.equal(setSecretSafely({}, "adaptive-key", "secret"), false);
	assert.equal(
		getSecretSafely({
			secretStorage: {
				getSecret: () => {
					throw new Error("locked");
				},
				setSecret: () => undefined,
			},
		}, "adaptive-key"),
		null
	);
	assert.equal(
		setSecretSafely({
			secretStorage: {
				getSecret: () => null,
				setSecret: () => {
					throw new Error("locked");
				},
			},
		}, "adaptive-key", "secret"),
		false
	);
});

test("default practice view settings keep the question pane on the left", () => {
	assert.equal(DEFAULT_SETTINGS.questionPaneSide, "left");
	assert.equal(DEFAULT_SETTINGS.dashboardOpen, false);
});

test("practice drafts normalize unfinished generated sessions for reload resume", () => {
	const now = Date.UTC(2026, 5, 27, 12);
	const topics = [makeTopic({
		title: "Rotated binary search",
		aliases: ["Rotation pivot invariant"],
	})];
	const questions = [
		makeQuestion({ id: "q1", sourceTopics: [topics[0]!.title] }),
		makeQuestion({ id: "q2", sourceTopics: [topics[0]!.title] }),
	];
	const draft = buildPracticeDraft(
		questions,
		[makeResult(questions[0]!, { timeTakenMs: 45_000 })],
		99,
		topics,
		{
			topics,
			questionCount: 2,
			mode: "daily",
			challengeMode: "stretch",
			challengeReason: "fluent recall",
		},
		now
	);
	const normalized = normalizePracticeDraft(draft, now + 60_000);

	assert.ok(normalized);
	assert.equal(normalized.currentIndex, 1);
	assert.equal(normalized.results.length, 1);
	assert.equal(normalized.config.mode, "daily");
	assert.equal(normalized.config.challengeMode, "stretch");
	assert.deepEqual(normalized.topics[0]?.aliases, ["Rotation pivot invariant"]);
	assert.deepEqual(normalized.config.topics[0]?.aliases, ["Rotation pivot invariant"]);
	assert.equal(practiceDraftProgress(normalized), "1 / 2 answered");
});

test("practice drafts count sparse saved results by answered slots", () => {
	const now = Date.UTC(2026, 5, 27, 12);
	const topics = [makeTopic({ title: "Rotated binary search" })];
	const questions = [
		makeQuestion({ id: "q1", sourceTopics: [topics[0]!.title] }),
		makeQuestion({ id: "q2", sourceTopics: [topics[0]!.title] }),
		makeQuestion({ id: "q3", sourceTopics: [topics[0]!.title] }),
	];
	const sparseResults = [] as QuizResult[];
	sparseResults[1] = makeResult(questions[1]!, { timeTakenMs: 45_000 });

	const draft = buildPracticeDraft(
		questions,
		sparseResults,
		2,
		topics,
		{
			topics,
			questionCount: 3,
			mode: "daily",
			challengeMode: "steady",
			challengeReason: "balanced challenge",
		},
		now
	);
	const normalized = normalizePracticeDraft(draft, now + 60_000);

	assert.ok(normalized);
	assert.equal(normalized.currentIndex, 0);
	assert.equal(practiceDraftProgress(normalized), "1 / 3 answered");
	assert.equal(normalized.results[1]?.question.id, "q2");
	assert.equal(normalized.results[0], undefined);
});

test("practice drafts drop stale, completed, or malformed sessions", () => {
	const now = Date.UTC(2026, 5, 27, 12);
	const topics = [makeTopic()];
	const questions = [makeQuestion({ id: "q1" })];
	const valid = buildPracticeDraft(
		questions,
		[],
		0,
		topics,
		{ topics, questionCount: 1 },
		now
	);
	const completed = buildPracticeDraft(
		questions,
		[makeResult(questions[0]!)],
		0,
		topics,
		{ topics, questionCount: 1 },
		now
	);

	assert.equal(normalizePracticeDraft(valid, now + 8 * DAY_MS), null);
	assert.equal(normalizePracticeDraft(completed, now), null);
	assert.equal(normalizePracticeDraft({ ...valid, questions: [] }, now), null);
	assert.equal(normalizePracticeDraft({ ...valid, topics: [] }, now), null);
});

test("practice drafts can preserve completed sessions until results are saved", () => {
	const now = Date.UTC(2026, 5, 27, 12);
	const topics = [makeTopic()];
	const questions = [makeQuestion({ id: "q1" }), makeQuestion({ id: "q2" })];
	const completed = {
		...buildPracticeDraft(
			questions,
			questions.map((question) => makeResult(question, { timeTakenMs: 45_000 })),
			1,
			topics,
			{ topics, questionCount: 2, mode: "daily" },
			now
		),
		completed: true as const,
	};
	const partialButMarked = {
		...completed,
		results: [completed.results[0]!],
	};
	const normalized = normalizePracticeDraft(completed, now + 60_000);

	assert.ok(normalized);
	assert.equal(normalized.completed, true);
	assert.equal(normalized.config.mode, "daily");
	assert.match(practiceDraftProgress(normalized), /ready to save/);
	assert.equal(normalizePracticeDraft(partialButMarked, now), null);
	assert.equal(shouldConfirmPracticeDraftReplacement(completed, false), false);
});

test("practice draft replacement prompts only for valid unfinished drafts", () => {
	// Real current time: shouldConfirmPracticeDraftReplacement normalizes
	// against Date.now() internally, so a fixed fixture date silently expires
	// once it is more than the draft max-age in the past.
	const now = Date.now();
	const topics = [makeTopic()];
	const questions = [
		makeQuestion({ id: "q1" }),
		makeQuestion({ id: "q2" }),
	];
	const draft = buildPracticeDraft(
		questions,
		[makeResult(questions[0]!, { timeTakenMs: 30_000 })],
		1,
		topics,
		{ topics, questionCount: 2 },
		now
	);
	const completed = buildPracticeDraft(
		questions,
		questions.map((question) => makeResult(question, { timeTakenMs: 30_000 })),
		1,
		topics,
		{ topics, questionCount: 2 },
		now
	);

	assert.equal(shouldConfirmPracticeDraftReplacement(draft, false), true);
	assert.equal(shouldConfirmPracticeDraftReplacement(draft, true), false);
	assert.equal(shouldConfirmPracticeDraftReplacement(completed, false), false);
	assert.equal(shouldConfirmPracticeDraftReplacement(null, false), false);
});

test("markdown block detection catches fenced code with indentation", () => {
	assert.equal(hasBlockMarkdown("Trace this:\n```ts\nlet mid = 2;\n```"), true);
	assert.equal(hasBlockMarkdown("Trace this:\n   ```python\nprint(mid)\n   ```"), true);
	assert.equal(hasBlockMarkdown("Use `nums[mid]` inline only."), false);
});

test("markdown render normalization repairs escaped fenced code newlines", () => {
	const escaped = "```ts\\nconst x = 1;\\nconsole.log(x);\\n```";
	const normalized = normalizeMarkdownForRender(escaped);

	assert.equal(normalized, "```ts\nconst x = 1;\nconsole.log(x);\n```");
	assert.equal(hasBlockMarkdown(normalized), true);
	assert.equal(
		normalizeMarkdownForRender("Use `\\n` as an escaped newline in a string."),
		"Use `\\n` as an escaped newline in a string."
	);
	assert.equal(
		normalizeMarkdownForRender("```ts\nconst slash = \"\\\\n\";\n```"),
		"```ts\nconst slash = \"\\\\n\";\n```"
	);
});

test("question history blocks preserve fenced code as renderable Markdown", () => {
	const question = makeQuestion({
		id: "trace-code",
		questionText: `Trace this branch:

\`\`\`ts
if (nums[mid] > nums[right]) {
  low = mid + 1;
}
\`\`\``,
		correctAnswer: `\`\`\`ts
low = mid + 1
\`\`\``,
		explanation: "The pivot must be to the right of `mid`.",
		sourceSubtopics: ["pivot invariant"],
		difficulty: "medium",
	});
	const block = buildQuestionHistoryBlock(
		makeResult(question, {
			userAnswer: `\`\`\`ts
low = mid + 1
\`\`\``,
			timeTakenMs: 62_000,
		})
	);

	assert.match(block, /<!-- Adaptive Practice question: [a-z0-9]+ -->/);
	assert.match(block, /\*\*Question\*\*\n\nTrace this branch:\n\n```ts/);
	assert.match(block, /\*\*Your answer\*\*\n\n```ts\nlow = mid \+ 1\n```/);
	assert.match(block, /\*\*Correct answer\*\*\n\n```ts\nlow = mid \+ 1\n```/);
	assert.match(block, /\*\*Source subtopics:\*\* pivot invariant/);
});

test("question history removal deletes marker-delimited blocks and empty sessions", () => {
	const question = makeQuestion({
		id: "remove-me",
		questionText: "Why does the invariant survive?",
		correctAnswer: "The target interval is preserved.",
	});
	const result = makeResult(question);
	const block = buildQuestionHistoryBlock(result);
	const content = [
		"# Rotated binary search",
		"",
		"## Practice history",
		"<!-- Adaptive Practice log - do not edit above this line -->",
		"### Session: 2026-06-27 11:40",
		block,
		"### Session: 2026-06-27 12:00",
		buildQuestionHistoryBlock(makeResult(makeQuestion({ id: "keep-me" }))),
		"",
	].join("\n");

	const removed = removeQuestionHistoryEntry(content, result);

	assert.equal(removed.removed, true);
	assert.doesNotMatch(removed.content, /remove-me/);
	assert.doesNotMatch(removed.content, /2026-06-27 11:40/);
	assert.match(removed.content, /keep-me/);
	assert.match(removed.content, /2026-06-27 12:00/);
});

test("topic group helpers prefer readable courses and folders", () => {
	assert.equal(stringifyGroupValue(" Algorithms "), "Algorithms");
	assert.equal(stringifyGroupValue(["Algorithms", "CS"]), "Algorithms, CS");
	assert.equal(stringifyGroupValue(42), "42");
	assert.equal(stringifyGroupValue({ course: "Hidden" }), "");
	assert.equal(folderLabel("Practice Lab/CS Wikipedia/Binary search algorithm.md"), "CS Wikipedia");
	assert.equal(folderLabel("Practice Lab/Assets/cache-whiteboard.png"), "Practice Lab");
	assert.equal(folderLabel("Root.md"), "");
});

test("vault scanner yields only between large-vault batches", () => {
	assert.equal(shouldYieldScanBatch(0, 1_000, 250), false);
	assert.equal(shouldYieldScanBatch(249, 1_000, 250), false);
	assert.equal(shouldYieldScanBatch(250, 1_000, 250), true);
	assert.equal(shouldYieldScanBatch(500, 500, 250), false);
	assert.equal(shouldYieldScanBatch(250, 1_000, 0), false);
});

test("vault index freshness uses raw file stats, not only frontmatter dates", () => {
	const topic = makeTopic({
		title: "Projectile motion - moving platform note",
		aliases: ["Relative velocity projectile"],
		path: "Practice Lab/JEE Physics/Projectile motion - moving platform note.md",
		createdAt: Date.UTC(2026, 2, 13),
		updatedAt: Date.UTC(2026, 5, 26),
	});
	const entry = makeIndexEntry({
		path: topic.path,
		title: topic.title,
		aliases: topic.aliases,
		createdAt: topic.createdAt!,
		updatedAt: topic.updatedAt!,
		fileCreatedAt: Date.UTC(2026, 5, 1, 8),
		fileUpdatedAt: Date.UTC(2026, 5, 26, 10),
		size: 4096,
		skill: topic.skill,
	});

	assert.equal(
		isIndexEntryCurrent(entry, topic, {
			createdAt: entry.fileCreatedAt,
			updatedAt: entry.fileUpdatedAt,
			size: entry.size,
		}),
		true
	);
	assert.equal(
		isIndexEntryCurrent(entry, topic, {
			createdAt: entry.fileCreatedAt,
			updatedAt: entry.fileUpdatedAt + 1000,
			size: entry.size,
		}),
		false
	);
	assert.equal(
		isIndexEntryCurrent(
			{ ...entry, aliases: ["Old moving-platform alias"] },
			topic,
			{
				createdAt: entry.fileCreatedAt,
				updatedAt: entry.fileUpdatedAt,
				size: entry.size,
			}
		),
		false
	);
});

test("provider compatibility filters PDF topics for text-only adapters", () => {
	const note = makeTopic({ title: "Rotated arrays", path: "cs/rotated.md" });
	const pdf = makeTopic({
		title: "RC transient card",
		path: "assets/rc-transient-card.pdf",
		isPdf: true,
	});

	const openAi = splitProviderCompatibleTopics("openai", [note, pdf]);
	assert.deepEqual(openAi.compatibleTopics.map((topic) => topic.title), [note.title]);
	assert.deepEqual(openAi.skippedPdfTopics.map((topic) => topic.title), [pdf.title]);
	assert.match(openAi.warning, /OpenAI cannot read PDF topic attachments/);
	assert.equal(getProviderPdfWarning("openai", [note]), "");

	const gemini = splitProviderCompatibleTopics("gemini", [note, pdf]);
	assert.equal(gemini.compatibleTopics.length, 2);
	assert.equal(gemini.skippedPdfTopics.length, 0);
	assert.equal(gemini.warning, "");
});

test("provider daily candidate limits search past due PDFs for text-only adapters", () => {
	assert.equal(dailyTopicCandidateLimitForProvider("gemini", 400, 6), 6);
	assert.equal(dailyTopicCandidateLimitForProvider("openai", 400, 6), 400);
	assert.equal(dailyTopicCandidateLimitForProvider("deepseek", 5, 6), 5);
});

test("provider attachment support follows provider capabilities and image override", () => {
	assert.deepEqual(
		getProviderAttachmentSupport("gemini", DEFAULT_SETTINGS),
		{ includeImages: true, includePdfs: true }
	);
	assert.deepEqual(
		getProviderAttachmentSupport("openai", DEFAULT_SETTINGS),
		{ includeImages: true, includePdfs: false }
	);
	assert.deepEqual(
		getProviderAttachmentSupport("deepseek", DEFAULT_SETTINGS),
		{ includeImages: false, includePdfs: false }
	);
	assert.deepEqual(
		getProviderAttachmentSupport("openai-compatible", {
			...DEFAULT_SETTINGS,
			providerSupportsImages: {
				"openai-compatible": true,
			},
		}),
		{ includeImages: true, includePdfs: false }
	);
});

test("prompt media attachment predicate skips binaries unsupported by provider policy", () => {
	assert.equal(
		shouldAttachPromptMedia({ kind: "image", mimeType: "image/png" }, {
			includeImages: false,
			includePdfs: true,
		}),
		false
	);
	assert.equal(
		shouldAttachPromptMedia({ kind: "pdf", mimeType: "application/pdf" }, {
			includeImages: true,
			includePdfs: false,
		}),
		false
	);
	assert.equal(
		shouldAttachPromptMedia({ kind: "image", mimeType: "image/webp" }, {
			includeImages: true,
			includePdfs: false,
		}),
		true
	);
	assert.equal(
		shouldAttachPromptMedia({ kind: "svg", mimeType: "image/svg+xml" }),
		false
	);
});

test("PDF attachment budget reports oversized standalone PDFs before upload", () => {
	assert.equal(formatBytes(0), "0 B");
	assert.equal(formatBytes(1536), "1.5 KB");
	assert.equal(
		pdfAttachmentSizeError("tiny.pdf", MAX_PDF_ATTACHMENT_BYTES),
		""
	);
	assert.match(
		pdfAttachmentSizeError("Practice Lab/Assets/giant.pdf", MAX_PDF_ATTACHMENT_BYTES + 1),
		/giant\.pdf.*10 MB/
	);
});

test("note cleaner removes clipped junk while preserving fenced code", () => {
	const cleaned = cleanNoteText(`
# Interesting proof

Skip to content
Subscribe

The actual idea survives.

\`\`\`txt
Subscribe
Share
\`\`\`

Related articles
© 2026 Example Site
`);
	const sections = extractSections(cleaned);
	const proseBeforeFence = cleaned.split("```")[0] ?? "";

	assert.doesNotMatch(proseBeforeFence, /^Subscribe$/m);
	assert.doesNotMatch(proseBeforeFence, /Related articles/);
	assert.doesNotMatch(proseBeforeFence, /Example Site/);
	assert.match(cleaned, /The actual idea survives/);
	assert.match(cleaned, /```txt\nSubscribe\nShare\n```/);
	assert.equal(sections.length, 1);
	assert.equal(sections[0]?.heading, "Interesting proof");
	assert.match(sections[0]?.content ?? "", /actual idea/);
});

test("frontmatter sanitizer bounds clipped metadata for prompt budget", () => {
	const hugeDescription = "Clipped article boilerplate ".repeat(80);
	const raw: Record<string, unknown> = {
		position: { x: 10, y: 20 },
		course: "JEE Physics",
		tags: ["jee", "physics", "capacitors"],
		description: hugeDescription,
		nested: {
			source: "clipper",
			extras: Array.from({ length: 30 }, (_, index) => `extra-${index}`),
		},
	};
	for (let i = 0; i < 70; i++) {
		raw[`noisy_${i}`] = `noise ${i}`;
	}

	const sanitized = sanitizeFrontmatter(raw);

	assert.equal(sanitized.position, undefined);
	assert.equal(sanitized.course, "JEE Physics");
	assert.equal(sanitized.tags, "jee, physics, capacitors");
	assert.match(sanitized.description ?? "", /\[\.\.\.truncated\]/);
	assert.match(sanitized.nested ?? "", /\+6 more/);
	assert.match(sanitized.__omitted ?? "", /additional frontmatter fields omitted/);
	assert.ok(Object.values(sanitized).join("\n").length < 13_000);
});

test("note media parsers handle Obsidian aliases, anchors, sizes, and encoded paths", () => {
	assert.deepEqual(
		parseInternalEmbedReference("Practice Lab/Assets/rc-transient-card.pdf#page=1|tiny card"),
		{
			link: "Practice Lab/Assets/rc-transient-card.pdf",
			alt: "tiny card",
		}
	);
	assert.deepEqual(
		parseInternalEmbedReference("Practice Lab/Assets/cache-whiteboard.png|400"),
		{
			link: "Practice Lab/Assets/cache-whiteboard.png",
			alt: "Practice Lab/Assets/cache-whiteboard.png",
		}
	);
	assert.equal(
		cleanMarkdownPath("<Practice%20Lab/Assets/cache-whiteboard.png> \"whiteboard\""),
		"Practice Lab/Assets/cache-whiteboard.png"
	);
	assert.equal(
		cleanMarkdownPath("Practice%20Lab/Assets/rotated-array-diagram.svg \"diagram\""),
		"Practice Lab/Assets/rotated-array-diagram.svg"
	);
});

test("note display titles prefer frontmatter title and aliases", () => {
	assert.equal(
		noteDisplayTitle(
			{
				title: "Rotated sorted array invariants",
				aliases: ["Binary search rotation"],
			},
			"rotated-array-lab"
		),
		"Rotated sorted array invariants"
	);
	assert.equal(
		noteDisplayTitle(
			{
				aliases: ["", "[[RC transient intuition]]"],
			},
			"rc-transient-half-page"
		),
		"RC transient intuition"
	);
	assert.equal(
		noteDisplayTitle(
			{
				title: " ".repeat(4),
				aliases: "Charging curve, capacitor current",
			},
			"capacitor-note"
		),
		"Charging curve"
	);
	assert.deepEqual(
		noteDisplayAliases(
			{
				title: "Rotated sorted array invariants",
				aliases: ["Binary search rotation", "[[Pivot boundary]]", "binary search rotation"],
			},
			"Rotated sorted array invariants"
		),
		["Binary search rotation", "Pivot boundary"]
	);
});

test("markdown image parser captures remote URLs and nearby captions", () => {
	const refs = parseMarkdownImageReferences(`
![Flowchart](//upload.wikimedia.org/wikipedia/commons/thumb/5/5e/GCD.svg/250px-GCD.svg.png)

Flowchart of Euclid's algorithm.

![local whiteboard](Practice%20Lab/Assets/cache-whiteboard.png "whiteboard")

![heap cases](Practice Lab/Assets/heap (annotated).png "heap")

![rotated invariant][rotated-diagram]

![RC board][]

[rotated-diagram]: <Practice Lab/Assets/rotated (case split).svg> "case split"
[RC board]: Practice%20Lab/Assets/rc-transient-board.png

<img src="Practice%20Lab/Assets/chem-mechanism.png" alt="SN1 mechanism sketch">

<img src="//upload.wikimedia.org/example.png" title="Remote imported figure">

<img src="https://example.com/plot.svg?x=1&amp;y=2" alt="Rate &amp; extent plot">

<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="Practice%20Lab/Assets/lazy-whiteboard.png" alt="lazy board">

<img data-srcset="small.png 320w, Practice%20Lab/Assets/large-board.png 1280w" alt="srcset board">
`);

	assert.equal(refs.length, 10);
	assert.equal(refs[0]?.link, "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/GCD.svg/250px-GCD.svg.png");
	assert.equal(refs[0]?.alt, "Flowchart");
	assert.equal(refs[0]?.caption, "Flowchart of Euclid's algorithm.");
	assert.equal(refs[0]?.isRemote, true);
	assert.equal(refs[1]?.link, "Practice Lab/Assets/cache-whiteboard.png");
	assert.equal(refs[1]?.isRemote, false);
	assert.equal(refs[2]?.link, "Practice Lab/Assets/heap (annotated).png");
	assert.equal(refs[2]?.alt, "heap cases");
	assert.equal(refs[2]?.isRemote, false);
	assert.equal(refs[3]?.link, "Practice Lab/Assets/rotated (case split).svg");
	assert.equal(refs[3]?.alt, "rotated invariant");
	assert.equal(refs[3]?.caption, "");
	assert.equal(refs[4]?.link, "Practice Lab/Assets/rc-transient-board.png");
	assert.equal(refs[4]?.alt, "RC board");
	assert.equal(refs[5]?.link, "Practice Lab/Assets/chem-mechanism.png");
	assert.equal(refs[5]?.alt, "SN1 mechanism sketch");
	assert.equal(refs[5]?.isRemote, false);
	assert.equal(refs[6]?.link, "https://upload.wikimedia.org/example.png");
	assert.equal(refs[6]?.alt, "Remote imported figure");
	assert.equal(refs[6]?.isRemote, true);
	assert.equal(refs[7]?.link, "https://example.com/plot.svg?x=1&y=2");
	assert.equal(refs[7]?.alt, "Rate & extent plot");
	assert.equal(refs[7]?.isRemote, true);
	assert.equal(refs[8]?.link, "Practice Lab/Assets/lazy-whiteboard.png");
	assert.equal(refs[8]?.alt, "lazy board");
	assert.equal(refs[9]?.link, "Practice Lab/Assets/large-board.png");
	assert.equal(refs[9]?.alt, "srcset board");
});

test("local media link merging preserves captions and better alt text", () => {
	const links = new Map<string, LocalMediaLink>();
	mergeLocalMediaLink(links, {
		path: "Practice Lab/Assets/cache-whiteboard.png",
		alt: "Practice Lab/Assets/cache-whiteboard.png",
	});
	mergeLocalMediaLink(links, {
		path: "Practice Lab/Assets/cache-whiteboard.png",
		alt: "cache state sketch",
		caption: "Whiteboard showing valid, dirty, and tag bits.",
	});
	mergeLocalMediaLink(links, {
		path: "Practice Lab/Assets/cache-whiteboard.png",
		alt: "Practice Lab/Assets/cache-whiteboard.png",
		caption: "Less helpful duplicate caption.",
	});

	assert.deepEqual(links.get("Practice Lab/Assets/cache-whiteboard.png"), {
		path: "Practice Lab/Assets/cache-whiteboard.png",
		alt: "cache state sketch",
		caption: "Whiteboard showing valid, dirty, and tag bits.",
	});
});

test("remote image attachments fetch actual pixels for vision-capable prompts", async () => {
	const data = makeArrayBuffer([1, 2, 3, 4]);
	const media = makeRemoteImageMedia("https://upload.wikimedia.org/example.png");

	const attachment = await buildRemotePromptAttachment("Euclid", media, 1024, async (url) => {
		assert.equal(url, media.url);
		return {
			status: 200,
			headers: { "Content-Type": "image/png; charset=binary" },
			arrayBuffer: data,
		};
	});

	assert.ok(attachment);
	assert.equal(attachment.noteTitle, "Euclid");
	assert.equal(attachment.path, media.url);
	assert.equal(attachment.kind, "image");
	assert.equal(attachment.mimeType, "image/png");
	assert.equal(attachment.data.byteLength, 4);
});

test("remote image attachments require safe public HTTPS URLs", async () => {
	assert.equal(isSafeRemoteAttachmentUrl("https://upload.wikimedia.org/example.png"), true);
	assert.equal(isSafeRemoteAttachmentUrl("http://upload.wikimedia.org/example.png"), false);
	assert.equal(isSafeRemoteAttachmentUrl("https://localhost/example.png"), false);
	assert.equal(isSafeRemoteAttachmentUrl("https://127.0.0.1/example.png"), false);
	assert.equal(isSafeRemoteAttachmentUrl("https://192.168.0.4/example.png"), false);
	assert.equal(isSafeRemoteAttachmentUrl("https://[::1]/example.png"), false);
	assert.equal(isSafeRemoteAttachmentUrl("https://user:pass@example.com/image.png"), false);

	const unsafe = await buildRemotePromptAttachment(
		"Unsafe",
		makeRemoteImageMedia("http://example.com/image.png"),
		1024,
		async () => {
			throw new Error("unsafe URL should not be fetched");
		}
	);
	assert.equal(unsafe, null);
});

test("remote image attachments skip unsafe or oversized downloads", async () => {
	const media = makeRemoteImageMedia("https://upload.wikimedia.org/example.png");
	const html = await buildRemotePromptAttachment("Euclid", media, 1024, async () => ({
		status: 200,
		headers: { "content-type": "text/html" },
		arrayBuffer: makeArrayBuffer([60, 33]),
	}));
	const oversized = await buildRemotePromptAttachment("Euclid", media, 2, async () => ({
		status: 200,
		headers: { "content-type": "image/jpeg" },
		arrayBuffer: makeArrayBuffer([1, 2, 3]),
	}));

	assert.equal(html, null);
	assert.equal(oversized, null);
});

test("parseSkillValue accepts numeric strings and clamps invalid frontmatter", () => {
	assert.equal(parseSkillValue("57.3"), 57.3);
	assert.equal(parseSkillValue("120"), 100);
	assert.equal(parseSkillValue("-5"), 0);
	assert.equal(parseSkillValue("not yet", 42), 42);
});

test("frontmatter date helpers prefer configured properties", () => {
	assert.deepEqual(
		normalizeDatePropertyNames("created, created_at, created"),
		["created", "created_at"]
	);
	assert.equal(
		frontmatterDateMs(
			{
				Created: "2026-06-24",
				modified: "20260626",
				unused: "not a date",
			},
			"created"
		),
		Date.UTC(2026, 5, 24)
	);
	assert.equal(
		frontmatterDateMs(
			{
				updated: 1_782_432_000,
			},
			"updated"
		),
		1_782_432_000_000
	);
	assert.equal(
		frontmatterDateMs(
			{
				modified: "20260626",
			},
			"updated, modified"
		),
		Date.UTC(2026, 5, 26)
	);
	assert.equal(frontmatterDateMs({ created: "not a date" }, "created"), null);
});

test("checkAnswer accepts normalized MCQ text and option prefixes", () => {
	const question = makeQuestion({
		type: "mcq",
		correctAnswer: "B. one half is always sorted",
	});

	assert.equal(checkAnswer(question, "one half is always sorted"), true);
	assert.equal(checkAnswer(question, "b) One half is always sorted"), true);
	assert.equal(checkAnswer(question, "left half is always sorted"), false);
});

test("checkAnswer grades select-all questions by exact set match", () => {
	const question = makeQuestion({
		type: "multi",
		options: ["stable under duplicates", "runs in place", "needs extra memory", "always logarithmic"],
		correctAnswers: ["stable under duplicates", "runs in place"],
		correctAnswer: "stable under duplicates\nruns in place",
	});

	assert.equal(checkAnswer(question, "stable under duplicates\nruns in place"), true);
	// Order never matters.
	assert.equal(checkAnswer(question, "runs in place\nstable under duplicates"), true);
	// Subset, superset, and swaps all fail.
	assert.equal(checkAnswer(question, "stable under duplicates"), false);
	assert.equal(
		checkAnswer(question, "stable under duplicates\nruns in place\nneeds extra memory"),
		false
	);
	assert.equal(checkAnswer(question, "stable under duplicates\nalways logarithmic"), false);
	assert.equal(checkAnswer(question, ""), false);
});

test("parseQuestions validates and normalizes select-all questions", () => {
	const valid = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "m1",
				type: "multi",
				questionText: "A learner claims several properties hold for the algorithm. Select every property the note actually supports, and be ready to justify why the rest fail.",
				options: [
					"It preserves relative order of equal keys",
					"It sorts in place with constant extra memory",
					"It always runs in logarithmic time",
					"It degrades to quadratic time on adversarial input",
					"It requires the input to be pre-sorted",
				],
				correctAnswers: [
					"It preserves relative order of equal keys",
					"It degrades to quadratic time on adversarial input",
				],
				correctAnswer: "",
				explanation: "Stability and the adversarial worst case are stated in the note; the others contradict it.",
				sourceTopics: ["Sorting"],
				sourceSubtopics: ["stability", "worst case"],
				difficulty: "medium",
			},
		],
	}));
	assert.equal(valid.length, 1);
	const question = valid[0]!;
	assert.equal(question.type, "multi");
	assert.equal(question.options?.length, 5);
	assert.equal(question.correctAnswers?.length, 2);
	assert.ok(question.correctAnswers?.every((entry) => question.options?.includes(entry)));
	assert.equal(question.correctAnswer, question.correctAnswers?.join("\n"));

	// All options correct is not a valid select-all question; neither is one.
	const degenerate = parseQuestions(JSON.stringify({
		questions: [
			{
				id: "m2",
				type: "multi",
				questionText: "Pick everything.",
				options: ["a", "b", "c", "d"],
				correctAnswers: ["a", "b", "c", "d"],
				correctAnswer: "",
				explanation: "x",
				sourceTopics: ["Sorting"],
				sourceSubtopics: [],
				difficulty: "easy",
			},
			{
				id: "m3",
				type: "multi",
				questionText: "Pick one thing only.",
				options: ["a", "b", "c", "d"],
				correctAnswers: ["a"],
				correctAnswer: "",
				explanation: "x",
				sourceTopics: ["Sorting"],
				sourceSubtopics: [],
				difficulty: "easy",
			},
		],
	}));
	assert.equal(degenerate.length, 0);
});

test("checkAnswer accepts common numeric formatting for decimals", () => {
	assert.equal(
		checkAnswer(
			makeQuestion({ type: "decimal", correctAnswer: "$1,000\\ \\mathrm{J}$" }),
			"1000 J"
		),
		true
	);
	assert.equal(
		checkAnswer(
			makeQuestion({ type: "decimal", correctAnswer: "1\\times 10^{-3}" }),
			"0.001"
		),
		true
	);
	assert.equal(
		checkAnswer(
			makeQuestion({ type: "decimal", correctAnswer: "\\frac{1}{2}" }),
			"0.5"
		),
		true
	);
	assert.equal(
		checkAnswer(
			makeQuestion({ type: "decimal", correctAnswer: "63.2%" }),
			"63.21 %"
		),
		true
	);
});

test("checkAnswer grades integers strictly instead of rounding", () => {
	const question = makeQuestion({ type: "integer", correctAnswer: "4" });

	assert.equal(checkAnswer(question, "4"), true);
	assert.equal(checkAnswer(question, "$4$"), true);
	assert.equal(checkAnswer(question, "4.0"), true);
	assert.equal(checkAnswer(question, "3.6"), false);
	assert.equal(checkAnswer(question, "4.2"), false);
});

test("fluency rewards fast correct answers and treats skips as non-fluent", () => {
	const question = makeQuestion({ difficulty: "medium" });
	const fastCorrect = makeResult(question, {
		isCorrect: true,
		timeTakenMs: 30_000,
	});
	const slowCorrect = makeResult(question, {
		isCorrect: true,
		timeTakenMs: 180_000,
	});
	const skipped = makeResult(question, {
		isCorrect: false,
		skipped: true,
		timeTakenMs: 10_000,
	});

	assert.equal(resultFluency(fastCorrect), 1);
	assert.ok(resultFluency(slowCorrect) < resultFluency(fastCorrect));
	assert.equal(resultFluency(skipped), 0);
	assert.equal(averageFluency([fastCorrect, skipped]), 0.5);
});

test("computeSkillDeltas weights fluency and skips in skill movement", () => {
	const topics = [makeTopic({ skill: 50 })];
	const question = makeQuestion({
		difficulty: "hard",
		sourceTopics: [topics[0]!.title],
	});

	const fastDelta = computeSkillDeltas(topics, [
		makeResult(question, { isCorrect: true, timeTakenMs: 30_000 }),
	])[0];
	const slowDelta = computeSkillDeltas(topics, [
		makeResult(question, { isCorrect: true, timeTakenMs: 260_000 }),
	])[0];
	const missDelta = computeSkillDeltas(topics, [
		makeResult(question, { isCorrect: false, timeTakenMs: 60_000 }),
	])[0];
	const skipDelta = computeSkillDeltas(topics, [
		makeResult(question, {
			isCorrect: false,
			skipped: true,
			timeTakenMs: 10_000,
		}),
	])[0];

	assert.ok(fastDelta);
	assert.ok(slowDelta);
	assert.ok(missDelta);
	assert.ok(skipDelta);
	assert.ok(fastDelta.after > slowDelta.after);
	assert.ok(skipDelta.after < missDelta.after);
});

test("computeSkillDeltas falls back when generated questions omit source topics", () => {
	const topics = [makeTopic({ skill: 50 })];
	const question = makeQuestion({
		sourceTopics: [],
		difficulty: "medium",
	});

	const delta = computeSkillDeltas(topics, [
		makeResult(question, { isCorrect: true, timeTakenMs: 30_000 }),
	])[0];

	assert.ok(delta);
	assert.ok(delta.after > delta.before);
});

test("reconcileGeneratedQuestions maps source paths and short titles to selected topics", () => {
	const rotated = makeTopic({
		path: "Practice Lab/CS/Rotated Binary Search - messy lab note.md",
		title: "Rotated Binary Search - messy lab note",
	});
	const rc = makeTopic({
		path: "Practice Lab/JEE Physics/Capacitors and RC transients - half page.md",
		title: "Capacitors and RC transients - half page",
	});
	const questions = reconcileGeneratedQuestions(
		[
			makeQuestion({
				sourceTopics: [
					"Practice Lab/CS/Rotated Binary Search - messy lab note.md",
					"RC transients",
					"RC transients",
				],
				sourceSubtopics: [" pivot invariant ", "", "pivot invariant"],
			}),
		],
		[rotated, rc]
	);

	assert.deepEqual(questions[0]?.sourceTopics, [
		rotated.title,
		rc.title,
	]);
	assert.deepEqual(questions[0]?.sourceSubtopics, ["pivot invariant"]);
});

test("reconcileSourceTopics matches filename aliases after frontmatter title changes", () => {
	const topic = makeTopic({
		path: "Practice Lab/CS/rotated-array-lab.md",
		title: "Rotated sorted array invariants",
	});

	assert.deepEqual(
		reconcileSourceTopics(["rotated-array-lab"], [topic]),
		[topic.title]
	);
	assert.deepEqual(
		reconcileSourceTopics(["Practice Lab/CS/rotated-array-lab.md"], [topic]),
		[topic.title]
	);
});

test("reconcileSourceTopics matches frontmatter aliases when title differs", () => {
	const topic = makeTopic({
		path: "Practice Lab/CS/rotated-array-lab.md",
		title: "Rotated sorted array invariants",
		aliases: ["Binary search rotation", "Pivot boundary"],
	});

	assert.deepEqual(
		reconcileSourceTopics(["binary search rotation"], [topic]),
		[topic.title]
	);
	assert.deepEqual(
		reconcileSourceTopics(["Pivot boundary"], [topic]),
		[topic.title]
	);
});

test("reconcileSourceTopics maps note aliases and loose title mentions to the note", () => {
	const linux = makeTopic({
		path: "ocr_output/L01-LinuxCommands/Linux Commands.md",
		title: "Linux Commands",
		skill: 83,
		aliases: ["Shell", "Bash", "CLI"],
	});
	const networks = makeTopic({
		path: "networks/Intro Networks.md",
		title: "Intro Networks",
	});

	// Frontmatter aliases resolve exactly; bare mentions of a title token
	// ("Linux") resolve by containment — no domain knowledge involved.
	for (const source of ["Shell", "Bash", "CLI", "Linux", "Linux Commands.md", "commands"]) {
		assert.deepEqual(
			reconcileSourceTopics([source], [linux, networks]),
			[linux.title],
			source
		);
	}
	assert.deepEqual(reconcileSourceTopics(["unknown"], [linux, networks]), ["unknown"]);
});

test("reconcileSourceTopics uses conservative fallbacks for missing sources", () => {
	const a = makeTopic({ title: "A topic", path: "a.md" });
	const b = makeTopic({ title: "B topic", path: "b.md" });

	assert.deepEqual(reconcileSourceTopics([], [a]), ["A topic"]);
	assert.deepEqual(reconcileSourceTopics([], [a, b]), ["A topic", "B topic"]);
	assert.deepEqual(reconcileSourceTopics(["unknown"], [a, b]), ["unknown"]);
});

test("resolveQuestionTargetTopics saves path-based questions to their note", () => {
	const topic = makeTopic({
		path: "Practice Lab/CS/Rotated Binary Search - messy lab note.md",
		title: "Rotated Binary Search - messy lab note",
	});
	const result = makeResult(makeQuestion({ sourceTopics: [topic.path] }));

	assert.deepEqual(resolveQuestionTargetTopics([topic], result), [topic]);
});

test("resolveQuestionTargetTopics falls back to all topics when source topics are empty", () => {
	const a = makeTopic({ title: "A topic", path: "a.md" });
	const b = makeTopic({ title: "B topic", path: "b.md" });
	const result = makeResult(makeQuestion({ sourceTopics: [] }));

	assert.deepEqual(resolveQuestionTargetTopics([a, b], result), [a, b]);
});

test("question quality gate merges top-up batches without duplicates", () => {
	const accepted = [
		makeQuestion({
			id: "q1",
			questionText: "Why does low move when nums[mid] > nums[right]?",
			correctAnswer: "pivot is right of mid",
		}),
		makeQuestion({
			id: "q2",
			questionText: "What is the all-duplicates worst case?",
			correctAnswer: "linear",
		}),
	];
	const topUp = [
		makeQuestion({
			id: "q2-duplicate",
			questionText: "What is the all duplicates worst case?",
			correctAnswer: "linear",
		}),
		makeQuestion({
			id: "q3",
			questionText: "Which invariant fails if duplicates hide the sorted side?",
			correctAnswer: "strict sorted-half detection",
		}),
		makeQuestion({
			id: "q4",
			questionText: "Which counterexample makes binary search degrade?",
			correctAnswer: "all equal non-target values",
		}),
	];

	const merged = mergeQuestionBatches(accepted, topUp, 4);

	assert.deepEqual(merged.map((question) => question.id), ["q1", "q2", "q3", "q4"]);
});

test("question quality gate builds a strict top-up prompt for missing questions", () => {
	const prompt = buildQuestionTopUpPrompt(
		{
			textPrompt: "Generate exactly 8 questions now.",
			attachments: [],
		},
		[
			makeQuestion({
				questionText: "A".repeat(320),
				correctAnswer: "answer",
			}),
			makeQuestion({
				questionText: "Why is duplicate trimming linear?",
				correctAnswer: "one element per side can be removed",
			}),
		],
		8
	);

	assert.match(prompt.textPrompt, /generate exactly 6 additional questions/i);
	assert.match(prompt.textPrompt, /Every MCQ must have exactly 4 unique/);
	assert.match(prompt.textPrompt, /Already accepted question stems/);
	assert.match(prompt.textPrompt, /Why is duplicate trimming linear/);
	assert.match(prompt.textPrompt, /A{80}/);
	assert.ok(prompt.textPrompt.length < 2000);
});

test("question quality gate asks challenge retries for genuinely hard questions", () => {
	const prompt = buildChallengeTopUpPrompt(
		{
			textPrompt: "Generate exactly 8 questions now.",
			attachments: [],
		},
		[
			makeQuestion({
				questionText: "What boundary update is safe?",
				correctAnswer: "shrink both ends",
				difficulty: "easy",
			}),
			makeQuestion({
				questionText: "Explain why `ls -a` shows dotfiles while plain `ls` does not.",
				correctAnswer: "`-a` includes entries whose names begin with `.`.",
				sourceTopics: ["Linux Commands"],
				sourceSubtopics: ["Shell wildcard characters", "ls options"],
				difficulty: "medium",
			}),
		],
		8
	);

	assert.match(prompt.textPrompt, /Generate exactly 8 replacement-grade questions/);
	assert.match(prompt.textPrompt, /two or more substantial reasoning moves/);
	assert.match(prompt.textPrompt, /Do not include easy questions/);
	assert.match(prompt.textPrompt, /direct update recall/);
	assert.match(prompt.textPrompt, /direct complexity recall/);
	assert.match(prompt.textPrompt, /one-branch checks/);
	assert.match(prompt.textPrompt, /\[medium\] Explain why `ls -a` shows dotfiles/);
	assert.match(prompt.textPrompt, /do not repeat name-the-tool, option-purpose, definition/);
	assert.match(prompt.textPrompt, /comparison stems as medium/);
});

test("difficulty calibration treats shell recall as easy but multi-constraint shell reasoning as hard", () => {
	const recall = makeQuestion({
		questionText: "Which command prints the kernel version?",
		correctAnswer: "uname -r",
		explanation: "`uname -r` prints the kernel release.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["uname"],
		difficulty: "hard",
	});
	const dressedUpRecall = makeQuestion({
		questionText: "In a Linux shell, compare `uname -o` and `uname -r`. Which one prints the kernel version, and why is the other option wrong?",
		correctAnswer: "uname -r",
		explanation: "`uname -r` prints kernel release; `uname -o` prints the operating system.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["uname"],
		difficulty: "hard",
	});
	const pipeRecall = makeQuestion({
		questionText: "Given `ls -l | cat`, what does the pipe connect between the two commands?",
		correctAnswer: "stdout of `ls -l` to stdin of `cat`",
		explanation: "A pipe sends standard output of the left process to standard input of the right process.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["Pipes"],
		difficulty: "medium",
	});
	const sessionRecall = makeQuestion({
		questionText: "Compare `who -u` and `last`: which one shows other currently logged-in sessions rather than historical sessions, and why?",
		correctAnswer: "who -u",
		explanation: "`who -u` shows current login sessions; `last` shows login history.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["Other sessions", "Session history"],
		difficulty: "medium",
	});
	const fakeMediumOptionPurpose = makeQuestion({
		questionText: "Explain why `ls -a` shows dotfiles while plain `ls` does not.",
		correctAnswer: "`-a` includes entries whose names begin with `.`.",
		explanation: "`ls -a` includes hidden dotfiles; plain `ls` omits them.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["Shell wildcard characters", "ls options"],
		difficulty: "medium",
	});
	const fakeMediumPipePurpose = makeQuestion({
		questionText: "In `ls -l | less`, explain what the pipe connects and why the output becomes page-scrollable.",
		correctAnswer: "The pipe connects stdout of `ls -l` to stdin of `less`.",
		explanation: "`less` reads the listing from stdin and displays it page by page.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["Redirection, Pipes and Filters", "less"],
		difficulty: "medium",
	});
	const fakeMediumPermissionDecode = makeQuestion({
		questionText: "Given `chmod 755 script.sh`, explain which user classes can execute the file.",
		correctAnswer: "Owner, group, and others can execute it.",
		explanation: "The execute bit is set in 7, 5, and 5.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["Default permissions", "chmod"],
		difficulty: "medium",
	});
	const fakeMediumSignalCompare = makeQuestion({
		questionText: "Compare `kill PID` and `kill -9 PID`: which one sends SIGKILL?",
		correctAnswer: "`kill -9 PID` sends SIGKILL.",
		explanation: "Signal number 9 is SIGKILL; plain `kill` sends SIGTERM by default.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["Processes and signals"],
		difficulty: "medium",
	});
	const fakeMediumOptionMeaning = makeQuestion({
		questionText: "For `grep -R pattern .`, what does `-R` do and when would you use it?",
		options: [
			"It searches recursively through directories",
			"It treats the pattern as a raw string only",
			"It reverses the order of matching lines",
			"It reads patterns from standard input",
		],
		correctAnswer: "It searches recursively through directories",
		explanation: "`grep -R` descends through directories and searches files under them.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["grep"],
		difficulty: "medium",
	});
	const fakeMediumSimpleRedirectCommand = makeQuestion({
		questionText: "Write the command that redirects only stderr from `grep foo missing.txt` into `errors.log` while leaving stdout on the terminal.",
		options: [
			"grep foo missing.txt 2>errors.log",
			"grep foo missing.txt >errors.log",
			"grep foo missing.txt 2>&1 errors.log",
			"grep foo missing.txt | errors.log",
		],
		correctAnswer: "grep foo missing.txt 2>errors.log",
		explanation: "File descriptor 2 is stderr.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["stderr redirection"],
		difficulty: "medium",
	});
	const simpleQuotePrediction = makeQuestion({
		questionText: "Predict the output of `echo \"$HOME\"` versus `echo '$HOME'` and explain why they differ.",
		options: [
			"Double quotes expand HOME; single quotes keep `$HOME` literal",
			"Both commands print `$HOME` literally",
			"Both commands print the home directory path",
			"Single quotes expand HOME; double quotes keep it literal",
		],
		correctAnswer: "Double quotes expand HOME; single quotes keep `$HOME` literal",
		explanation: "The shell expands variables inside double quotes but not inside single quotes.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["quoting", "shell expansion"],
		difficulty: "hard",
	});
	const descriptorRecall = makeQuestion({
		questionText: "What does `2>&1` do in a shell command?",
		options: [
			"Redirect stderr to the current stdout destination",
			"Redirect stdout to stderr",
			"Pipe stderr to stdin",
			"Discard both streams",
		],
		correctAnswer: "Redirect stderr to the current stdout destination",
		explanation: "It duplicates stdout onto file descriptor 2.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["stderr redirection"],
		difficulty: "medium",
	});
	const descriptorOrderTrap = makeQuestion({
		questionText: "Which statement correctly explains why `cmd >out 2>&1` differs from `cmd 2>&1 >out`?",
		options: [
			"The first sends both streams to `out`; the second sends stderr to the old stdout before stdout changes",
			"They are identical because redirections are commutative",
			"The second sends stdout to stderr",
			"The first discards stderr",
		],
		correctAnswer: "The first sends both streams to `out`; the second sends stderr to the old stdout before stdout changes",
		explanation: "Redirections are applied left to right, so `2>&1` copies the stdout destination at that moment.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["stdout", "stderr", "redirection order"],
		difficulty: "medium",
	});
	const permissionDerivation = makeQuestion({
		questionText: "Given requested file mode `666` and `umask 027`, derive the final permission bits and explain which user classes lose which bits.",
		correctAnswer: "640",
		explanation: "The umask removes group write and all other bits from the requested file mode, leaving 640.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["Default permissions", "umask"],
		difficulty: "medium",
	});
	const whyBaitCommandSpotting = makeQuestion({
		questionText: [
			"Given a directory tree that may contain spaces in filenames and permission-denied subdirectories, construct the safest one-line command to find `.log` files modified in the last 7 days, count matching lines containing `ERROR`, and keep stderr out of the count.",
			"Which command sequence is correct, and why does it avoid the common xargs/quoting trap?",
		].join(" "),
		options: [
			"find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l",
			"find . -name *.log -mtime -7 | xargs grep ERROR 2>/dev/null | wc -l",
			"grep -R ERROR *.log 2>&1 | wc -l",
			"ls -R | grep '.log' | xargs grep ERROR | wc -l",
		],
		correctAnswer: "find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l",
		explanation: "Null-delimited output preserves paths with spaces, stderr is redirected before the pipeline, and grep receives only safe file arguments.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["find", "xargs", "quoting", "stderr redirection", "pipes"],
		difficulty: "medium",
	});
	const reasoning = makeQuestion({
		questionText: [
			"Given a directory tree that may contain spaces in filenames and permission-denied subdirectories, construct the safest one-line command to find `.log` files modified in the last 7 days, count matching lines containing `ERROR`, and keep stderr out of the count.",
			"A teammate's attempt inflated the count with permission-denied text and split filenames with spaces; debug that failure mode. Which command sequence and explanation is correct?",
		].join(" "),
		options: [
			"`find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l`, because null-delimited paths preserve spaces and `2>/dev/null` removes find errors before the pipe",
			"`find . -name *.log -mtime -7 | xargs grep ERROR 2>/dev/null | wc -l`, because the shell expands `*.log` recursively and xargs preserves spaces by default",
			"`grep -R ERROR *.log 2>&1 | wc -l`, because merging stderr into stdout keeps permission errors out of the count",
			"`ls -R | grep '.log' | xargs grep ERROR | wc -l`, because listing names is equivalent to passing file paths from find",
		],
		correctAnswer: "`find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l`, because null-delimited paths preserve spaces and `2>/dev/null` removes find errors before the pipe",
		explanation: "Null-delimited output preserves paths with spaces, stderr is redirected before the pipeline, and grep receives only safe file arguments.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["find", "xargs", "quoting", "stderr redirection", "pipes"],
		difficulty: "medium",
	});
	const fakeHardOptionSpotting = makeQuestion({
		questionText: "Given a directory tree that may contain spaces in filenames and permission-denied subdirectories, which command sequence correctly counts `ERROR` lines in `.log` files modified in the last 7 days while keeping stderr out of the count?",
		options: [
			"find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l",
			"find . -name *.log -mtime -7 | xargs grep ERROR 2>/dev/null | wc -l",
			"grep -R ERROR *.log 2>&1 | wc -l",
			"ls -R | grep '.log' | xargs grep ERROR | wc -l",
		],
		correctAnswer: "find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l",
		explanation: "The correct option uses null-delimited paths and redirects stderr before the pipe.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["find", "xargs", "quoting", "stderr redirection", "pipes"],
		difficulty: "hard",
	});
	const multiSinkPipelineTrace = makeQuestion({
		questionText: "Given `{ printf \"a\\nb\\n\"; printf \"warn\\n\" >&2; } 2>producer.err | grep b >out.txt 2>grep.err`, predict the terminal output, contents of `producer.err`, `out.txt`, and `grep.err`, and explain which process each redirection applies to.",
		options: [
			"Terminal prints nothing; `producer.err` contains `warn`; `out.txt` contains `b`; `grep.err` is empty",
			"Terminal prints `warn`; `out.txt` contains `b`; both error files are empty",
			"`producer.err` contains `b`; `out.txt` contains `warn`; `grep.err` is empty",
			"`grep.err` contains `warn`; `out.txt` contains `a` and `b`; terminal prints nothing",
		],
		correctAnswer: "Terminal prints nothing; `producer.err` contains `warn`; `out.txt` contains `b`; `grep.err` is empty",
		explanation: "The producer's stderr is redirected before the pipe, only producer stdout enters grep, grep stdout goes to `out.txt`, and grep stderr goes to `grep.err`.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["pipes", "stdout", "stderr", "redirection"],
		difficulty: "medium",
	});

	assert.equal(normalizeQuestionDifficulty(recall), "easy");
	assert.equal(normalizeQuestionDifficulty(dressedUpRecall), "easy");
	assert.equal(normalizeQuestionDifficulty(pipeRecall), "easy");
	assert.equal(normalizeQuestionDifficulty(sessionRecall), "easy");
	assert.equal(normalizeQuestionDifficulty(fakeMediumOptionPurpose), "easy");
	assert.equal(normalizeQuestionDifficulty(fakeMediumPipePurpose), "easy");
	assert.equal(normalizeQuestionDifficulty(fakeMediumPermissionDecode), "easy");
	assert.equal(normalizeQuestionDifficulty(fakeMediumSignalCompare), "easy");
	assert.equal(normalizeQuestionDifficulty(fakeMediumOptionMeaning), "easy");
	assert.equal(normalizeQuestionDifficulty(fakeMediumSimpleRedirectCommand), "easy");
	assert.equal(normalizeQuestionDifficulty(simpleQuotePrediction), "easy");
	assert.equal(normalizeQuestionDifficulty(descriptorRecall), "easy");
	assert.equal(normalizeQuestionDifficulty(descriptorOrderTrap), "hard");
	assert.equal(normalizeQuestionDifficulty(permissionDerivation), "medium");
	assert.equal(normalizeQuestionDifficulty(fakeHardOptionSpotting), "easy");
	assert.equal(normalizeQuestionDifficulty(whyBaitCommandSpotting), "medium");
	assert.equal(normalizeQuestionDifficulty(multiSinkPipelineTrace), "hard");
	assert.equal(normalizeQuestionDifficulty(reasoning), "hard");
});

test("normalizePracticeMemory backfills fluency fields for older saved data", () => {
	const memory = normalizePracticeMemory({
		version: 1,
		notes: {
			"old.md": {
				path: "old.md",
				title: "Old note",
				skill: 120,
				createdAt: 0,
				updatedAt: 0,
				lastPracticedAt: 0,
				dueAt: 0,
				attempts: 2,
				correct: 1,
				correctStreak: 0,
				stabilityDays: 0,
				practicedSubtopics: {},
			},
		},
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: 0,
		},
	} as unknown as PracticeMemory);

	const state = memory.notes["old.md"];
	assert.ok(state);
	assert.equal(state.skill, 100);
	assert.equal(state.skipped, 0);
	assert.equal(state.averageTimeMs, 0);
	assert.equal(state.lastSessionAccuracy, 0);
	assert.equal(state.lastSessionFluency, 0);
});

test("question feedback stores bounded evaluation labels", () => {
	const question = makeQuestion({
		questionText: "Why does the duplicate-heavy rotated search degrade to linear time?",
		correctAnswer: "Equal low/mid/high values only let us shrink both ends.",
		sourceTopics: ["Rotated binary search"],
		sourceSubtopics: ["Duplicate ambiguity"],
		difficulty: "medium",
	});
	const result = makeResult(question, {
		isCorrect: true,
		timeTakenMs: 42_000,
	});
	const now = Date.UTC(2026, 5, 27, 10);
	const memory = recordQuestionFeedback(
		normalizePracticeMemory(undefined),
		result,
		"too_easy",
		now
	);

	const feedback = memory.questionFeedback ?? [];
	assert.equal(feedback.length, 1);
	assert.equal(feedback[0]?.kind, "too_easy");
	assert.equal(feedback[0]?.difficulty, "medium");
	assert.equal(feedback[0]?.sourceSubtopics[0], "Duplicate ambiguity");
	assert.equal(feedback[0]?.wasCorrect, true);

	const updated = recordQuestionFeedback(memory, result, "too_easy", now + 1000);
	const replacedFeedback = updated.questionFeedback ?? [];
	assert.equal(replacedFeedback.length, 1);
	assert.equal(replacedFeedback[0]?.createdAt, now + 1000);

	let bounded = updated;
	for (let i = 0; i < 260; i++) {
		bounded = recordQuestionFeedback(
			bounded,
			makeResult(makeQuestion({ id: `q-${i}`, questionText: `Question ${i}` })),
			"bad_concept",
			now + i
		);
	}
	assert.equal((bounded.questionFeedback ?? []).length, 250);
});

test("reconcilePracticeMemory carries practice state across a moved note", () => {
	const oldPath = "Practice Lab/JEE Physics/Old/Projectile motion - moving platform note.md";
	const moved = makeTopic({
		path: "Practice Lab/JEE Physics/Mechanics/Projectile motion - moving platform note.md",
		title: "Projectile motion - moving platform note",
		createdAt: Date.UTC(2026, 2, 13),
		updatedAt: Date.UTC(2026, 5, 26),
		skill: 42,
	});
	const memory = normalizePracticeMemory({
		version: 1,
		notes: {
			[oldPath]: makeNoteState(
				{
					...moved,
					path: oldPath,
				},
				{
					attempts: 5,
					correct: 3,
					skipped: 1,
					dueAt: Date.UTC(2026, 6, 1),
					lastPracticedAt: Date.UTC(2026, 5, 20),
					practicedSubtopics: {
						"frame choice": {
							lastPracticedAt: Date.UTC(2026, 5, 20),
							attempts: 2,
							correct: 1,
						},
					},
				}
			),
		},
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: 0,
		},
	});

	const reconciled = reconcilePracticeMemory(
		memory,
		[moved],
		Date.UTC(2026, 5, 27)
	);

	assert.equal(reconciled.notes[oldPath], undefined);
	assert.equal(reconciled.notes[moved.path]?.attempts, 5);
	assert.equal(reconciled.notes[moved.path]?.correct, 3);
	assert.equal(
		reconciled.notes[moved.path]?.practicedSubtopics["frame choice"]?.attempts,
		2
	);
});

test("reconcilePracticeMemory avoids carrying unrelated batch-created notes", () => {
	const oldPath = "Practice Lab/JEE Physics/Rotational dynamics - rolling energy.md";
	const newTopic = makeTopic({
		path: "Practice Lab/JEE Chemistry/Organic substitution - SN1 SN2 solvent mess.md",
		title: "Organic substitution - SN1 SN2 solvent mess",
		createdAt: Date.UTC(2026, 5, 26),
		updatedAt: Date.UTC(2026, 5, 26),
		skill: 29,
	});
	const memory = normalizePracticeMemory({
		version: 1,
		notes: {
			[oldPath]: makeNoteState(
				{
					path: oldPath,
					title: "Rotational dynamics - rolling energy",
					skill: 35,
					isPdf: false,
					createdAt: Date.UTC(2026, 5, 26),
					updatedAt: Date.UTC(2026, 5, 26),
				},
				{ attempts: 7, correct: 6 }
			),
		},
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: 0,
		},
	});

	const reconciled = reconcilePracticeMemory(
		memory,
		[newTopic],
		Date.UTC(2026, 5, 27)
	);

	assert.equal(reconciled.notes[oldPath]?.attempts, 7);
	assert.equal(reconciled.notes[newTopic.path]?.attempts, 0);
	assert.equal(reconciled.notes[newTopic.path]?.skill, 29);
});

test("reminder attempt cooldown retries empty scans without burning the whole day", () => {
	const now = Date.UTC(2026, 5, 26, 18, 30);

	assert.equal(reminderAttemptCooldownHasPassed(0, now), true);
	assert.equal(reminderAttemptCooldownHasPassed(now - 29 * 60 * 1000, now), false);
	assert.equal(reminderAttemptCooldownHasPassed(now - 30 * 60 * 1000, now), true);
});

test("daily reminder attempts can retry until practice or explicit suppression", () => {
	const now = new Date(2026, 5, 26, 18, 30);
	const afterCooldown = new Date(now.getTime() + 31 * 60 * 1000);
	const memory = normalizePracticeMemory(undefined);

	assert.equal(shouldOfferDailyReminder({
		enabled: true,
		reminderTime: "18:00",
		memory,
		now,
	}), true);

	const attempted = recordDailyReminderAttempt(memory, now.getTime());
	assert.equal(attempted.daily.lastReminderDate, "");
	assert.equal(shouldOfferDailyReminder({
		enabled: true,
		reminderTime: "18:00",
		memory: attempted,
		now,
	}), false);
	assert.equal(shouldOfferDailyReminder({
		enabled: true,
		reminderTime: "18:00",
		memory: attempted,
		now: afterCooldown,
	}), true);
	assert.equal(shouldOfferDailyReminder({
		enabled: true,
		reminderTime: "18:00",
		memory: attempted,
		now: afterCooldown,
		hasPracticeDraft: true,
	}), false);

	const suppressed = suppressDailyReminderForToday(attempted, afterCooldown);
	assert.equal(shouldOfferDailyReminder({
		enabled: true,
		reminderTime: "18:00",
		memory: suppressed,
		now: afterCooldown,
	}), false);
});

test("updatePracticeMemoryAfterSession shortens spacing for slow recall", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic({ skill: 80 });
	const delta: SkillDelta = {
		path: topic.path,
		title: topic.title,
		before: topic.skill,
		after: topic.skill,
	};
	const question = makeQuestion({
		sourceTopics: [topic.title],
		difficulty: "medium",
	});

	const fastMemory = updatePracticeMemoryAfterSession(
		undefined,
		[topic],
		[makeResult(question, { isCorrect: true, timeTakenMs: 30_000 })],
		[delta],
		now
	);
	const slowMemory = updatePracticeMemoryAfterSession(
		undefined,
		[topic],
		[makeResult(question, { isCorrect: true, timeTakenMs: 180_000 })],
		[delta],
		now
	);
	const fastState = fastMemory.notes[topic.path];
	const slowState = slowMemory.notes[topic.path];

	assert.ok(fastState);
	assert.ok(slowState);
	assert.ok(fastState.stabilityDays > slowState.stabilityDays);
	assert.equal(slowState.lastSessionAccuracy, 1);
	assert.ok(slowState.lastSessionFluency < fastState.lastSessionFluency);
	assert.equal(slowState.averageTimeMs, 180_000);
});

test("updatePracticeMemoryAfterSession reconciles saved path source topics", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic({
		path: "Practice Lab/CS/Rotated Binary Search - messy lab note.md",
		title: "Rotated Binary Search - messy lab note",
		skill: 50,
	});
	const question = makeQuestion({
		sourceTopics: [topic.path],
		sourceSubtopics: ["pivot invariant"],
	});

	const memory = updatePracticeMemoryAfterSession(
		undefined,
		[topic],
		[makeResult(question, { isCorrect: true, timeTakenMs: 45_000 })],
		[],
		now
	);
	const state = memory.notes[topic.path]!;

	assert.equal(state.attempts, 1);
	assert.equal(state.correct, 1);
	assert.equal(state.practicedSubtopics["pivot invariant"]?.attempts, 1);
	assert.equal(state.lastPracticedAt, now);
});

test("selectDailyTopics can surface fragile slow-recall notes before they are due", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const fragile = makeTopic({
		path: "jee/rc-transients.md",
		title: "RC transients",
		skill: 88,
	});
	const stable = makeTopic({
		path: "cs/rotated-arrays.md",
		title: "Rotated arrays",
		skill: 90,
	});
	const futureDue = now + 5 * DAY_MS;
	const memory = normalizePracticeMemory({
		version: 1,
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: now,
		},
		notes: {
			[fragile.path]: makeNoteState(fragile, {
				dueAt: futureDue,
				attempts: 10,
				correct: 6,
				lastPracticedAt: now - 4 * DAY_MS,
				lastSessionAccuracy: 0.4,
				lastSessionFluency: 0.2,
			}),
			[stable.path]: makeNoteState(stable, {
				dueAt: futureDue,
				attempts: 10,
				correct: 9,
				lastPracticedAt: now - DAY_MS,
				lastSessionAccuracy: 0.95,
				lastSessionFluency: 0.9,
			}),
		},
	});

	const selected = selectDailyTopics([stable, fragile], memory, 1, now);

	assert.equal(selected.length, 1);
	assert.equal(selected[0]?.path, fragile.path);
	assert.match(selected[0]?.scheduleReason ?? "", /recent misses/);
	assert.match(selected[0]?.scheduleReason ?? "", /slow recall/);
});

test("selectDailyTopics introduces untouched notes only up to the daily limit", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topics = Array.from({ length: 20 }, (_, index) =>
		makeTopic({
			path: `cs/topic-${index + 1}.md`,
			title: `CS topic ${index + 1}`,
		})
	);

	const selected = selectDailyTopics(topics, undefined, 6, now);

	assert.equal(selected.length, 6);
	assert.deepEqual(
		selected.map((topic) => topic.title),
		["CS topic 1", "CS topic 2", "CS topic 3", "CS topic 4", "CS topic 5", "CS topic 6"]
	);
	assert.ok(selected.every((topic) => /new/.test(topic.scheduleReason ?? "")));
});

test("selectDailyTopics mixes due review with a capped untouched intro", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const dueTopics = [
		makeTopic({ path: "cs/graphs.md", title: "Graph traversals" }),
		makeTopic({ path: "math/integrals.md", title: "Definite integrals" }),
	];
	const newTopics = Array.from({ length: 12 }, (_, index) =>
		makeTopic({
			path: `backlog/new-${index + 1}.md`,
			title: `Untouched topic ${index + 1}`,
		})
	);
	const memory = normalizePracticeMemory({
		version: 1,
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: now,
		},
		notes: {
			[dueTopics[0]!.path]: makeNoteState(dueTopics[0]!, {
				attempts: 5,
				correct: 3,
				lastPracticedAt: now - 8 * DAY_MS,
				dueAt: now - DAY_MS,
				lastSessionAccuracy: 0.6,
				lastSessionFluency: 0.5,
			}),
			[dueTopics[1]!.path]: makeNoteState(dueTopics[1]!, {
				attempts: 4,
				correct: 4,
				lastPracticedAt: now - 7 * DAY_MS,
				dueAt: now - 2 * DAY_MS,
				lastSessionAccuracy: 1,
				lastSessionFluency: 0.9,
			}),
		},
	});

	const selected = selectDailyTopics([...dueTopics, ...newTopics], memory, 6, now);
	const untouchedCount = selected.filter((topic) =>
		topic.path.startsWith("backlog/")
	).length;

	assert.deepEqual(
		new Set(selected.slice(0, 2).map((topic) => topic.title)),
		new Set(["Graph traversals", "Definite integrals"])
	);
	assert.equal(untouchedCount, 3);
	assert.equal(selected.length, 5);
	assert.ok(selected.slice(2).every((topic) => /new/.test(topic.scheduleReason ?? "")));
});

test("selectDailyTopics moves past freshly imported notes already practiced today", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topics = Array.from({ length: 8 }, (_, index) =>
		makeTopic({
			path: `imports/topic-${index + 1}.md`,
			title: `Imported topic ${index + 1}`,
			createdAt: now - 2 * 60 * 60 * 1000,
			updatedAt: now - 2 * 60 * 60 * 1000,
		})
	);
	const practicedAt = now - 30 * 60 * 1000;
	const memory = normalizePracticeMemory({
		version: 1,
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: now,
		},
		notes: {
			[topics[0]!.path]: makeNoteState(topics[0]!, {
				attempts: 3,
				correct: 3,
				lastPracticedAt: practicedAt,
				dueAt: now + 3 * DAY_MS,
				lastSessionAccuracy: 1,
				lastSessionFluency: 0.9,
			}),
			[topics[1]!.path]: makeNoteState(topics[1]!, {
				attempts: 3,
				correct: 3,
				lastPracticedAt: practicedAt,
				dueAt: now + 3 * DAY_MS,
				lastSessionAccuracy: 1,
				lastSessionFluency: 0.9,
			}),
		},
	});

	const selected = selectDailyTopics(topics, memory, 4, now);

	assert.deepEqual(
		selected.map((topic) => topic.title),
		["Imported topic 3", "Imported topic 4", "Imported topic 5", "Imported topic 6"]
	);
});

test("selectPracticeMoreTopics keeps an extra batch available after due work is done", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topics = [
		makeTopic({
			path: "cs/red-black-trees.md",
			title: "Red-black trees",
			skill: 88,
		}),
		makeTopic({
			path: "physics/rolling-motion.md",
			title: "Rolling motion",
			skill: 60,
		}),
		makeTopic({
			path: "math/definite-integrals.md",
			title: "Definite integrals",
			skill: 74,
		}),
	];
	const memory = normalizePracticeMemory({
		version: 1,
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "2026-06-26",
			streak: 3,
			lastScanAt: now,
		},
		notes: Object.fromEntries(
			topics.map((topic) => [
				topic.path,
				makeNoteState(topic, {
					attempts: 5,
					correct: 5,
					lastPracticedAt: now - 45 * 60 * 1000,
					dueAt: now + 5 * DAY_MS,
					lastSessionAccuracy: 0.96,
					lastSessionFluency: 0.9,
				}),
			])
		),
	});

	const regular = selectDailyTopics(topics, memory, 3, now);
	const extra = selectPracticeMoreTopics(topics, memory, 2, now);

	assert.equal(regular.length, 0);
	assert.deepEqual(
		extra.map((topic) => topic.title),
		["Rolling motion", "Definite integrals"]
	);
	assert.ok(extra.every((topic) => /extra practice/.test(topic.scheduleReason ?? "")));
});

test("meaningful daily streak credit ignores skips and speed-clicked answers", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic();
	const question = makeQuestion({ sourceTopics: [topic.title] });
	const engagedResults = [
		makeResult(question, { isCorrect: true, timeTakenMs: 20_000 }),
		makeResult(question, { isCorrect: false, userAnswer: "B", timeTakenMs: 25_000 }),
		makeResult(question, { isCorrect: false, skipped: true, timeTakenMs: 5_000 }),
	];
	const skippedResults = Array.from({ length: 3 }, () =>
		makeResult(question, {
			isCorrect: false,
			skipped: true,
			timeTakenMs: 5_000,
		})
	);
	const speedClickedResults = Array.from({ length: 4 }, (_, index) =>
		makeResult(question, {
			isCorrect: index === 0,
			userAnswer: index === 0 ? question.correctAnswer : "B",
			timeTakenMs: 1_000,
		})
	);
	const sparseResults = [] as QuizResult[];
	sparseResults[3] = makeResult(question, {
		isCorrect: true,
		timeTakenMs: 45_000,
	});

	assert.equal(isMeaningfulPracticeSession(engagedResults), true);
	assert.equal(isMeaningfulPracticeSession(skippedResults), false);
	assert.equal(isMeaningfulPracticeSession(speedClickedResults), false);
	assert.equal(isMeaningfulPracticeSession(sparseResults), false);
	assert.equal(
		evaluatePracticeSessionMeaningfulness(skippedResults).reason,
		"too-few-attempts"
	);
	assert.equal(
		evaluatePracticeSessionMeaningfulness(speedClickedResults).reason,
		"too-fast-average"
	);
	assert.equal(
		evaluatePracticeSessionMeaningfulness(engagedResults).detail,
		"This session had enough deliberate answers to count for today."
	);

	const skippedMemory = updatePracticeMemoryAfterSession(
		undefined,
		[topic],
		skippedResults,
		[],
		now,
		{ countDailyCredit: true }
	);
	const engagedMemory = updatePracticeMemoryAfterSession(
		undefined,
		[topic],
		engagedResults,
		[],
		now,
		{ countDailyCredit: true }
	);

	assert.equal(hasPracticedToday(skippedMemory, new Date(now)), false);
	assert.equal(skippedMemory.daily.streak, 0);
	assert.equal(hasPracticedToday(engagedMemory, new Date(now)), true);
	assert.equal(engagedMemory.daily.streak, 1);
});

test("practice credit status explains daily streak outcomes", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic();
	const question = makeQuestion({ sourceTopics: [topic.title] });
	const before = normalizePracticeMemory(undefined);
	const skippedForCredit = [
		makeResult(question, { isCorrect: false, skipped: true, timeTakenMs: 2_000 }),
		makeResult(question, { isCorrect: false, skipped: true, timeTakenMs: 2_000 }),
	];
	const counted = updatePracticeMemoryAfterSession(
		before,
		[topic],
		[
			makeResult(question, { isCorrect: true, timeTakenMs: 20_000 }),
			makeResult(question, { isCorrect: true, timeTakenMs: 25_000 }),
		],
		[],
		now,
		{ countDailyCredit: true }
	);
	const notCounted = before;
	const extra = updatePracticeMemoryAfterSession(
		counted,
		[topic],
		[makeResult(question, { isCorrect: true, timeTakenMs: 30_000 })],
		[],
		now + 60_000,
		{ countDailyCredit: true }
	);

	assert.equal(
		resolvePracticeCredit(before, counted, new Date(now)).status,
		"counted"
	);
	assert.equal(
		resolvePracticeCredit(before, notCounted, new Date(now), skippedForCredit).status,
		"not-counted"
	);
	assert.match(
		resolvePracticeCredit(before, notCounted, new Date(now), skippedForCredit).detail,
		/non-skipped/
	);
	assert.equal(
		resolvePracticeCredit(counted, extra, new Date(now + 60_000)).status,
		"already-counted"
	);
});

test("manual practice updates note memory without counting daily streak", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic();
	const question = makeQuestion({ sourceTopics: [topic.title] });
	const updated = updatePracticeMemoryAfterSession(
		undefined,
		[topic],
		[
			makeResult(question, { isCorrect: true, timeTakenMs: 25_000 }),
			makeResult(question, { isCorrect: true, timeTakenMs: 30_000 }),
		],
		[],
		now
	);

	assert.equal(updated.notes[topic.path]?.attempts, 2);
	assert.equal(updated.notes[topic.path]?.lastPracticedAt, now);
	assert.equal(hasPracticedToday(updated, new Date(now)), false);
	assert.equal(updated.daily.streak, 0);
});

test("extra practice after a counted daily session does not add another streak day", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic();
	const question = makeQuestion({ sourceTopics: [topic.title] });
	const memory = normalizePracticeMemory({
		version: 1,
		index: {},
		daily: {
			lastReminderDate: "2026-06-26",
			lastReminderAttemptAt: now - 2 * 60 * 60 * 1000,
			lastPracticeDate: "2026-06-26",
			streak: 5,
			lastScanAt: now,
		},
		notes: {
			[topic.path]: makeNoteState(topic, {
				attempts: 3,
				correct: 3,
				lastPracticedAt: now - 60 * 60 * 1000,
				dueAt: now + 4 * DAY_MS,
				lastSessionAccuracy: 1,
				lastSessionFluency: 0.9,
			}),
		},
	});

	const updated = updatePracticeMemoryAfterSession(
		memory,
		[topic],
		[
			makeResult(question, { isCorrect: true, timeTakenMs: 25_000 }),
			makeResult(question, { isCorrect: true, timeTakenMs: 30_000 }),
		],
		[],
		now,
		{ countDailyCredit: true }
	);

	assert.equal(updated.daily.lastPracticeDate, "2026-06-26");
	assert.equal(updated.daily.streak, 5);
});

test("planDailySession keeps the configured count for fragile warm-up sessions", () => {
	const topic = makeTopic({ skill: 35 });
	const memory = normalizePracticeMemory({
		version: 1,
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: 0,
		},
		notes: {
			[topic.path]: makeNoteState(topic, {
				attempts: 6,
				correct: 2,
				skipped: 2,
				lastSessionAccuracy: 0.33,
				lastSessionFluency: 0.25,
			}),
		},
	});

	const plan = planDailySession([topic], memory, 10);

	assert.equal(plan.challengeMode, "warmup");
	assert.equal(plan.questionCount, 10);
	assert.match(plan.reason, /low skill/);
	assert.match(plan.reason, /recent misses/);
	assert.match(plan.reason, /slow recall/);
});

test("planDailySession keeps the configured count for fluent stretch sessions", () => {
	const topic = makeTopic({ skill: 88 });
	const memory = normalizePracticeMemory({
		version: 1,
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: 0,
		},
		notes: {
			[topic.path]: makeNoteState(topic, {
				attempts: 12,
				correct: 12,
				lastSessionAccuracy: 0.95,
				lastSessionFluency: 0.9,
			}),
		},
	});

	const plan = planDailySession([topic], memory, 19);

	assert.equal(plan.challengeMode, "stretch");
	assert.equal(plan.questionCount, 19);
	assert.match(plan.reason, /strong recent accuracy/);
});

test("planDailySession escalates after a fluent correct streak before skill catches up", () => {
	const topic = makeTopic({ skill: 52 });
	const memory = normalizePracticeMemory({
		version: 1,
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: 0,
		},
		notes: {
			[topic.path]: makeNoteState(topic, {
				attempts: 5,
				correct: 5,
				correctStreak: 5,
				lastSessionAccuracy: 1,
				lastSessionFluency: 0.78,
			}),
		},
	});

	const plan = planDailySession([topic], memory, 8);

	assert.equal(plan.challengeMode, "stretch");
	assert.equal(plan.questionCount, 8);
	assert.match(plan.reason, /correct streak/);
});

test("buildPrompt preserves structured metadata and media descriptions", () => {
	const topic = makeTopic({
		title: "RC transient whiteboard",
		aliases: ["Capacitor charging board", "First-order circuit sketch"],
	});
	const structure = makeStructure({
		title: topic.title,
		frontmatter: {
			skill: "62",
			exam: "JEE",
		},
		tags: ["#physics", "#circuits"],
		links: ["Capacitor intuition"],
		headings: [{ heading: "Charging curve traps", level: 2 }],
		sections: [
			{
				heading: "Charging curve traps",
				level: 2,
				content: "Remember that current is highest at t = 0 and decays exponentially.",
				wordCount: 11,
			},
		],
		media: [
			{
				path: "Assets/rc-transient.svg",
				alt: "RC charging curve",
				kind: "svg",
				mimeType: "image/svg+xml",
				size: 2048,
				source: "local",
				svgText: "<svg><text>tau marker at 63 percent</text></svg>",
			},
			{
				path: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/GCD.svg/250px-GCD.svg.png",
				alt: "GCD flowchart",
				caption: "Flowchart of Euclid's algorithm.",
				kind: "image",
				mimeType: "image/png",
				size: 0,
				source: "remote",
				url: "https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/GCD.svg/250px-GCD.svg.png",
			},
		],
	});
	const imageData = new ArrayBuffer(4);
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "## Practice history\n- missed tau interpretation",
				structure,
				attachments: [
					{
						noteTitle: topic.title,
						path: "Assets/rc-board.png",
						kind: "image",
						mimeType: "image/png",
						data: imageData,
					},
				],
			},
		],
		4
	);

	assert.match(prompt.textPrompt, /<frontmatter>/);
	assert.match(prompt.textPrompt, /### Topic: RC transient whiteboard/);
	assert.match(prompt.textPrompt, /Aliases \(context only; sourceTopics must use the Topic title\): Capacitor charging board, First-order circuit sketch/);
	assert.match(prompt.textPrompt, /exam: JEE/);
	assert.match(prompt.textPrompt, /Tags: #physics, #circuits/);
	assert.match(prompt.textPrompt, /<concept_targets>/);
	assert.match(prompt.textPrompt, /tau interpretation/);
	assert.match(prompt.textPrompt, /Assets\/rc-transient\.svg/);
	assert.match(prompt.textPrompt, /tau marker at 63 percent/);
	assert.match(prompt.textPrompt, /remote/);
	assert.match(prompt.textPrompt, /Flowchart of Euclid's algorithm/);
	assert.match(prompt.textPrompt, /https:\/\/upload\.wikimedia\.org/);
	assert.match(prompt.textPrompt, /missed tau interpretation/);
	assert.match(prompt.textPrompt, /Label a question "hard" only if/);
	assert.match(prompt.textPrompt, /Hard distractors must be tempting/);
	assert.equal(prompt.attachments.length, 1);
	assert.equal(prompt.attachments[0]?.data, imageData);
});

test("buildPrompt surfaces concept targets hidden in body-only notes", () => {
	const topic = makeTopic({ title: "Messy binary-search scratchpad" });
	const structure = makeStructure({
		title: topic.title,
		headings: [],
		sections: [
			{
				heading: "Body",
				level: 0,
				content: [
					"- **Monotonic predicate**: once true, every later candidate stays true.",
					"Pivot boundary trap: `low = mid` can stall when two candidates remain.",
				].join("\n"),
				wordCount: 19,
			},
		],
	});
	const concepts = extractConceptCandidates(structure);
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		3
	);

	assert.ok(concepts.includes("Monotonic predicate"));
	assert.ok(concepts.includes("Pivot boundary trap"));
	assert.match(prompt.textPrompt, /<concept_targets>/);
	assert.match(prompt.textPrompt, /Monotonic predicate/);
	assert.match(prompt.textPrompt, /Pivot boundary trap/);
});

test("buildPrompt includes compact subtopic memory to reduce repetition", () => {
	const topic = makeTopic({
		title: "Rotated binary search",
		dueAt: Date.UTC(2026, 6, 20),
	});
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: "Binary search variants depend on preserving the sorted-half invariant.",
				history: "",
				practicedSubtopics: {
					"pivot invariant": {
						lastPracticedAt: Date.UTC(2026, 5, 24),
						attempts: 5,
						correct: 5,
					},
					"duplicate worst case": {
						lastPracticedAt: Date.UTC(2026, 5, 25),
						attempts: 3,
						correct: 1,
					},
				},
			},
		],
		3,
		{ now: Date.UTC(2026, 5, 26) }
	);

	assert.match(prompt.textPrompt, /<subtopic_memory>/);
	assert.match(prompt.textPrompt, /duplicate worst case: 3 attempts, 33% correct/);
	assert.match(prompt.textPrompt, /duplicate worst case:.*guidance=revisit/);
	assert.match(prompt.textPrompt, /pivot invariant: 5 attempts, 100% correct/);
	assert.match(prompt.textPrompt, /pivot invariant:.*guidance=avoid-if-possible/);
	assert.match(prompt.textPrompt, /Subtopic memory rule/);
});

test("buildPrompt uses topic-scoped question feedback as calibration", () => {
	const topic = makeTopic({
		title: "Rotated binary search",
		aliases: ["Binary search rotation"],
	});
	const feedback: QuestionFeedbackEntry[] = [
		{
			id: "f1",
			kind: "too_easy",
			questionText: "Which half is eliminated when nums[low] <= nums[mid]?",
			correctAnswer: "The left half",
			difficulty: "medium",
			sourceTopics: ["Binary search rotation"],
			sourceSubtopics: ["Sorted half invariant"],
			wasCorrect: true,
			skipped: false,
			timeTakenMs: 20_000,
			createdAt: Date.UTC(2026, 5, 27, 9),
		},
		{
			id: "f2",
			kind: "bad_concept",
			questionText: "In Rotated binary search, what does the problem do?",
			correctAnswer: "It searches a rotated array",
			difficulty: "easy",
			sourceTopics: ["Rotated binary search"],
			sourceSubtopics: [],
			wasCorrect: true,
			skipped: false,
			timeTakenMs: 8_000,
			createdAt: Date.UTC(2026, 5, 27, 10),
		},
		{
			id: "f3",
			kind: "too_hard",
			questionText: "Unrelated stoichiometry trap should not leak into this CS prompt.",
			correctAnswer: "2 mol",
			difficulty: "hard",
			sourceTopics: ["Stoichiometry"],
			sourceSubtopics: ["Limiting reagent"],
			wasCorrect: false,
			skipped: false,
			timeTakenMs: 180_000,
			createdAt: Date.UTC(2026, 5, 27, 11),
		},
	];
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: "Rotated array search depends on a sorted-half invariant.",
				history: "",
			},
		],
		4,
		{ questionFeedback: feedback }
	);

	assert.match(prompt.textPrompt, /## Learner quality feedback/);
	assert.match(prompt.textPrompt, /Too easy \(1\): Often around Sorted half invariant/);
	assert.match(prompt.textPrompt, /Increase depth for similar concepts/);
	assert.match(prompt.textPrompt, /Bad concept \(1\):/);
	assert.match(prompt.textPrompt, /Avoid note-title recall/);
	assert.match(prompt.textPrompt, /Which half is eliminated/);
	assert.doesNotMatch(prompt.textPrompt, /Unrelated stoichiometry trap/);
});

test("buildPrompt marks mastered subtopics revisitable when the topic is due", () => {
	const topic = makeTopic({
		title: "Rotated binary search",
		dueAt: Date.UTC(2026, 5, 26),
	});
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: "Binary search variants depend on preserving the sorted-half invariant.",
				history: "",
				practicedSubtopics: {
					"pivot invariant": {
						lastPracticedAt: Date.UTC(2026, 5, 24),
						attempts: 5,
						correct: 5,
					},
				},
			},
		],
		2,
		{ now: Date.UTC(2026, 5, 26) }
	);

	assert.match(prompt.textPrompt, /pivot invariant:.*guidance=revisit-if-central/);
});

test("buildPrompt includes daily warm-up calibration when scheduler flags fragility", () => {
	const topic = makeTopic({ title: "Thermodynamics sign traps", skill: 32 });
	const structure = makeStructure({
		title: topic.title,
		sections: [
			{
				heading: "Sign convention",
				level: 2,
				content: "In chemistry, work done on the system is positive.",
				wordCount: 9,
			},
		],
	});
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		4,
		{
			challengeMode: "warmup",
			challengeReason: "low skill, slow recall",
		}
	);

	assert.match(prompt.textPrompt, /Session mode: warm-up/);
	assert.match(prompt.textPrompt, /Scheduler reason: low skill, slow recall/);
	assert.match(prompt.textPrompt, /use the skill-based target mix below/);
	assert.match(prompt.textPrompt, /diagnostic questions/);
});

test("buildPrompt keeps high-skill Linux warmups medium-hard", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const structure = makeStructure({
		title: topic.title,
		sections: [
			{
				heading: "Redirection, Pipes and Filters",
				level: 1,
				content: "Pipelines connect stdout to stdin. Redirection can send stderr separately, and xargs builds commands from input.",
				wordCount: 16,
			},
			{
				heading: "Shell wildcard characters",
				level: 1,
				content: "Wildcards are expanded by the shell before the command runs; quoting prevents expansion.",
				wordCount: 13,
			},
		],
	});
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		8,
		{
			challengeMode: "warmup",
			challengeReason: "recent misses",
		}
	);

	assert.match(prompt.textPrompt, /Session mode: warm-up/);
	assert.match(prompt.textPrompt, /Target mix for this session: 0 easy, 4 medium, 4 hard/);
	assert.match(prompt.textPrompt, /High-skill rule: do not generate easy questions/);
	assert.match(prompt.textPrompt, /When a high-skill note teaches procedures, tools, notation, or methods, hard questions must require doing/);
});

test("buildPrompt includes stretch calibration for fluent daily review", () => {
	const topic = makeTopic({ title: "Rotated binary search", skill: 88 });
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: "If nums[mid] > nums[right], the minimum is right of mid.",
				history: "",
			},
		],
		6,
		{
			challengeMode: "stretch",
			challengeReason: "strong recent accuracy and fluency",
		}
	);

	assert.match(prompt.textPrompt, /Session mode: stretch/);
	assert.match(prompt.textPrompt, /strong recent accuracy and fluency/);
	assert.match(prompt.textPrompt, /Target mix for this session: 0 easy, 1 medium, 5 hard/);
	assert.match(prompt.textPrompt, /mostly medium\/hard questions/);
	assert.match(prompt.textPrompt, /edge cases/);
});

test("buildPrompt targets hard shell practice for high-skill Linux notes", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 83 });
	const sections = [
		{
			heading: "License",
			level: 1,
			content: "Copyright CC BY NC SA",
			wordCount: 5,
		},
		{
			heading: "Agenda",
			level: 1,
			content: "Login, manuals, shell, users, process, files",
			wordCount: 6,
		},
		{
			heading: "uname",
			level: 1,
			content: "Use uname -a to know basic information about the system.",
			wordCount: 10,
		},
		{
			heading: "Shell wildcard characters",
			level: 1,
			content: "Wildcards are expanded by the shell before the command runs; quoting prevents expansion.",
			wordCount: 13,
		},
		{
			heading: "umask and chmod permissions",
			level: 1,
			content: "The umask removes permission bits from a requested mode. chmod changes owner, group, and other permission bits.",
			wordCount: 17,
		},
		{
			heading: "Redirection, Pipes and Filters",
			level: 1,
			content: "Pipelines connect stdout to stdin. Redirection can send stderr separately, and xargs builds commands from input.",
			wordCount: 16,
		},
		{
			heading: "Process jobs and signals",
			level: 1,
			content: "Foreground and background jobs receive signals differently. kill sends signals to process IDs.",
			wordCount: 13,
		},
	];
	const structure = makeStructure({
		title: topic.title,
		frontmatter: { skill: "83" },
		headings: sections.map((section) => ({
			heading: section.heading,
			level: section.level,
		})),
		sections,
		cleanedText: sections.map((section) => section.content).join("\n\n"),
	});
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		8,
		{ challengeMode: "steady" }
	);

	assert.match(prompt.textPrompt, /Target mix for this session: 0 easy, 2 medium, 6 hard/);
	assert.match(prompt.textPrompt, /High-skill rule: do not generate easy questions/);
	assert.match(prompt.textPrompt, /When a high-skill note teaches procedures, tools, notation, or methods, hard questions must require doing/);
	assert.match(prompt.textPrompt, /each option should pair the choice with its reasoning or trap/);
	assert.doesNotMatch(prompt.textPrompt, /<concept_targets>\n(?:.|\n)*- License/);
	assert.doesNotMatch(prompt.textPrompt, /<concept_targets>\n(?:.|\n)*- Agenda/);
	assert.doesNotMatch(prompt.textPrompt, /<outline>\n(?:.|\n)*- License/);
	assert.doesNotMatch(prompt.textPrompt, /<note_sections>\n(?:.|\n)*# License/);
	assert.match(prompt.textPrompt, /Redirection, Pipes and Filters/);
	assert.match(prompt.textPrompt, /umask and chmod permissions/);
});

test("buildPrompt raises shell depth guidance for 90-plus Linux notes", () => {
	const topic = makeTopic({ title: "Linux Commands", skill: 92 });
	const prompt = buildPrompt(
		[makeLinuxTopicContext(topic)],
		8,
		{ challengeMode: "steady" }
	);

	assert.match(prompt.textPrompt, /Target mix for this session: 0 easy, 1 medium, 7 hard/);
	assert.match(prompt.textPrompt, /For topics at skill 90\+, a hard question must combine at least two reasoning moves/);
});

test("buildPrompt keeps high-skill Linux guidance in mixed-skill sessions", () => {
	const linux = makeTopic({ title: "Linux Commands", skill: 83 });
	const networks = makeTopic({ title: "Intro Networks", skill: 25 });
	const prompt = buildPrompt(
		[
			makeLinuxTopicContext(linux),
			makeTopicContext(
				networks,
				"DNS maps hostnames to addresses. A TCP handshake exchanges SYN and ACK packets before data flows."
			),
		],
		8,
		{ challengeMode: "steady" }
	);

	assert.match(prompt.textPrompt, /Target mix for this session: 2 easy, 4 medium, 2 hard/);
	assert.match(prompt.textPrompt, /High-skill topic rule: for Linux Commands \(83\/100\), do not generate easy questions/);
	assert.match(prompt.textPrompt, /When a high-skill note teaches procedures, tools, notation, or methods, hard questions must require doing/);
});

test("buildPrompt focuses the real high-skill Linux Commands note on shell mechanics", () => {
	const notePath = "../../../ocr_output/L01-LinuxCommands/Linux Commands.md";
	if (!existsSync(notePath)) return;

	const raw = readFileSync(notePath, "utf8");
	const skill = frontmatterSkill(raw) ?? 83;
	assert.ok(skill > 80);
	const body = raw.replace(/^---[\s\S]*?---\s*/, "");
	const cleanedText = cleanNoteText(body);
	const sections = extractSections(cleanedText);
	const topic = makeTopic({
		path: "ocr_output/L01-LinuxCommands/Linux Commands.md",
		title: "Linux Commands",
		skill,
	});
	const structure = makeStructure({
		path: topic.path,
		title: topic.title,
		frontmatter: { skill: String(skill) },
		sections,
		headings: sections
			.filter((section) => section.level > 0)
			.map((section) => ({
				heading: section.heading,
				level: section.level,
			})),
		cleanedText,
	});
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: cleanedText,
				history: "",
				structure,
			},
		],
		8,
		{
			challengeMode: "steady",
			challengeReason: "real Linux note regression",
			now: Date.UTC(2026, 5, 30),
		}
	);
	const sectionsBlock = prompt.textPrompt.match(/<note_sections>\n([\s\S]*?)\n<\/note_sections>/)?.[1] ?? "";
	const conceptBlock = prompt.textPrompt.match(/<concept_targets>\n([\s\S]*?)\n<\/concept_targets>/)?.[1] ?? "";
	const desired = desiredDifficultyCounts(8, skill, "steady");

	assert.match(
		prompt.textPrompt,
		new RegExp(`Target mix for this session: ${desired.easy} easy, ${desired.medium} medium, ${desired.hard} hard`)
	);
	assert.match(prompt.textPrompt, new RegExp(`skill: ${escapeRegExp(String(skill))}`));
	assert.match(prompt.textPrompt, /High-skill rule: do not generate easy questions/);
	assert.match(prompt.textPrompt, /When a high-skill note teaches procedures, tools, notation, or methods, hard questions must require doing/);
	// Boilerplate is excluded by general low-value filters, not by any
	// vault-specific heading knowledge.
	assert.doesNotMatch(conceptBlock, /License|Agenda/);
	assert.doesNotMatch(sectionsBlock, /# License|# Agenda/);
	// A large note renders a real spread of sections with technical substance,
	// and the outline names what the excerpts omit.
	const renderedHeadings = sectionsBlock.match(/^#{1,6} .+$/gm) ?? [];
	assert.ok(renderedHeadings.length >= 8, `rendered ${renderedHeadings.length} sections`);
	assert.match(sectionsBlock, /`[^`\n]+`|\$ [a-z]/);
	assert.match(prompt.textPrompt, /<outline>/);
	assert.match(prompt.textPrompt, /additional sections omitted from excerpts/);
	assert.ok(conceptBlock.trim().split("\n").length >= 6, "expected several concept targets");
});

test("session generation repairs fake-medium output for the real high-skill Linux Commands note", async () => {
	const notePath = "../../../ocr_output/L01-LinuxCommands/Linux Commands.md";
	if (!existsSync(notePath)) return;

	const raw = readFileSync(notePath, "utf8");
	const skill = frontmatterSkill(raw) ?? 83;
	assert.ok(skill > 80);
	const body = raw.replace(/^---[\s\S]*?---\s*/, "");
	const cleanedText = cleanNoteText(body);
	const sections = extractSections(cleanedText);
	const topic = makeTopic({
		path: "ocr_output/L01-LinuxCommands/Linux Commands.md",
		title: "Linux Commands",
		skill,
	});
	const structure = makeStructure({
		path: topic.path,
		title: topic.title,
		frontmatter: { skill: String(skill) },
		sections,
		headings: sections
			.filter((section) => section.level > 0)
			.map((section) => ({
				heading: section.heading,
				level: section.level,
			})),
		cleanedText,
	});
	const context: TopicContext = {
		note: topic,
		content: cleanedText,
		history: "",
		structure,
	};
	const config: SessionConfig = {
		topics: [topic],
		questionCount: 8,
		challengeMode: "steady",
		challengeReason: "real high-skill Linux fake-medium regression",
	};
	const desired = desiredDifficultyCounts(config.questionCount, skill, config.challengeMode);
	const client = makeBatchClient([
		Array.from({ length: 8 }, (_, index) =>
			makeLinuxFakeMediumRecallQuestion(`real-note-fake-medium-${index}`)
		),
		[
			...Array.from({ length: desired.hard }, (_, index) =>
				makeLinuxHardQuestion(`real-note-repair-hard-${index}`)
			),
			...Array.from({ length: desired.medium }, (_, index) =>
				makeLinuxMediumQuestion(`real-note-repair-medium-${index}`)
			),
		],
	]);

	const questions = await generateQuestionsFromClient(
		client,
		{ textPrompt: "Generate exactly 8 questions from the real Linux Commands note.", attachments: [] },
		config,
		[context]
	);

	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]?.textPrompt ?? "", /Challenge correction/);
	assert.equal(
		questions.some((question) => question.id.startsWith("real-note-fake-medium")),
		false
	);
	assert.equal(questions.filter((question) => question.difficulty === "easy").length, 0);
	assert.equal(questions.filter((question) => question.difficulty === "hard").length, desired.hard);
	assert.equal(questions.filter((question) => question.difficulty === "medium").length, desired.medium);
	assert.equal(challengeShortfallMessage(questions, [topic], "steady", 8), "");
});

test("buildPrompt bounds excerpts for notes with many sections", () => {
	const topic = makeTopic({ title: "Large interleaved vault note" });
	const sections = Array.from({ length: 300 }, (_, index) => {
		const sectionNumber = index + 1;
		const content = `Section ${sectionNumber} detail `.repeat(260);
		return {
			heading: `Section ${sectionNumber}`,
			level: 2,
			content,
			wordCount: content.trim().split(/\s+/).length,
		};
	});
	const structure = makeStructure({
		title: topic.title,
		headings: sections.map((section) => ({
			heading: section.heading,
			level: section.level,
		})),
		sections,
		cleanedText: sections.map((section) => section.content).join("\n\n"),
	});
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				structure,
			},
		],
		12
	);

	assert.ok(prompt.textPrompt.length < 140_000);
	assert.match(prompt.textPrompt, /additional sections omitted/);
	assert.match(prompt.textPrompt, /## Section 300/);
	assert.doesNotMatch(prompt.textPrompt, /Section 150 detail(?: Section 150 detail){120}/);
});

test("buildPrompt keeps huge manual selections inside the global excerpt budget", () => {
	const contexts = Array.from({ length: 120 }, (_, topicIndex) => {
		const title = `Manual batch note ${topicIndex + 1}`;
		const sections = Array.from({ length: 30 }, (_, sectionIndex) => {
			const sectionNumber = sectionIndex + 1;
			const content = `Topic ${topicIndex + 1} section ${sectionNumber} detail `.repeat(80);
			return {
				heading: `Section ${sectionNumber}`,
				level: 2,
				content,
				wordCount: content.trim().split(/\s+/).length,
			};
		});
		const structure = makeStructure({
			title,
			headings: sections.map((section) => ({
				heading: section.heading,
				level: section.level,
			})),
			sections,
			cleanedText: sections.map((section) => section.content).join("\n\n"),
		});
		return {
			note: makeTopic({
				path: `batch/note-${topicIndex + 1}.md`,
				title,
			}),
			content: structure.cleanedText,
			history: "",
			structure,
		};
	});
	const prompt = buildPrompt(contexts, 20);

	assert.ok(prompt.textPrompt.length < 180_000);
	assert.match(prompt.textPrompt, /additional sections omitted/);
	assert.doesNotMatch(prompt.textPrompt, /Topic 1 section 15 detail(?: Topic 1 section 15 detail){40}/);
});

test("buildPrompt prioritizes weak subtopic sections in long notes", () => {
	const topic = makeTopic({ title: "Messy mechanics notebook" });
	const sections = Array.from({ length: 40 }, (_, index) => {
		const sectionNumber = index + 1;
		const content = sectionNumber === 24
			? "Weak moving-platform frame choice: use truck-relative displacement for a target fixed on the truck."
			: `Routine section ${sectionNumber} notes `.repeat(80);
		return {
			heading: `Section ${sectionNumber}`,
			level: 2,
			content,
			wordCount: content.trim().split(/\s+/).length,
		};
	});
	const structure = makeStructure({
		title: topic.title,
		headings: sections.map((section) => ({
			heading: section.heading,
			level: section.level,
		})),
		sections,
		cleanedText: sections.map((section) => section.content).join("\n\n"),
	});
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: structure.cleanedText,
				history: "",
				practicedSubtopics: {
					"Section 24": {
						lastPracticedAt: Date.UTC(2026, 5, 20),
						attempts: 4,
						correct: 1,
					},
				},
				structure,
			},
		],
		8,
		{ now: Date.UTC(2026, 5, 26) }
	);

	assert.match(prompt.textPrompt, /Section 24: 4 attempts, 25% correct/);
	assert.match(prompt.textPrompt, /## Section 24\nWeak moving-platform frame choice/);
	assert.match(prompt.textPrompt, /additional sections omitted/);
});

const DAY_MS = 24 * 60 * 60 * 1000;

function frontmatterSkill(markdown: string): number | null {
	const match = markdown.match(/^---[\s\S]*?\bskill:\s*([0-9]+(?:\.[0-9]+)?)/);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeBatchClient(
	batches: Question[][]
): LlmClient & { calls: StructuredPrompt[] } {
	const calls: StructuredPrompt[] = [];
	return {
		calls,
		async generateQuestions(prompt: StructuredPrompt): Promise<Question[]> {
			calls.push(prompt);
			return batches.shift() ?? [];
		},
	};
}

function makeLinuxSessionConfig(topic: TopicNote): SessionConfig {
	return {
		topics: [topic],
		questionCount: 8,
		challengeMode: "steady",
		challengeReason: "high-skill Linux regression",
	};
}

function makeLinuxTopicContext(topic: TopicNote): TopicContext {
	const sections = [
		{
			heading: "Shell wildcard characters",
			level: 1,
			content: "Wildcards are expanded by the shell before commands run; quoting keeps text literal.",
			wordCount: 13,
		},
		{
			heading: "Default permissions",
			level: 1,
			content: "umask removes bits from requested permissions when files or directories are created.",
			wordCount: 12,
		},
		{
			heading: "Redirection, Pipes and Filters",
			level: 1,
			content: "stdout, stderr, pipes, filters, and xargs interact differently depending on where redirection appears.",
			wordCount: 13,
		},
	];
	const structure = makeStructure({
		title: topic.title,
		sections,
		headings: sections.map((section) => ({
			heading: section.heading,
			level: section.level,
		})),
		cleanedText: sections.map((section) => section.content).join("\n\n"),
	});
	return {
		note: topic,
		content: structure.cleanedText,
		history: "",
		structure,
	};
}

function makeTopicContext(topic: TopicNote, content: string): TopicContext {
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: topic.title, level: 1 }],
		sections: [
			{
				heading: topic.title,
				level: 1,
				content,
				wordCount: content.trim().split(/\s+/).filter(Boolean).length,
			},
		],
		cleanedText: content,
	});
	return {
		note: topic,
		content,
		history: "",
		structure,
	};
}

function makeLinuxRecallQuestion(id: string): Question {
	return makeQuestion({
		id,
		questionText: `Which command prints the kernel version for ${id}?`,
		correctAnswer: "uname -r",
		explanation: "`uname -r` prints the kernel release.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["uname"],
		difficulty: "easy",
	});
}

function makeLinuxMediumQuestion(id: string): Question {
	return makeQuestion({
		id,
		questionText: `Given requested file mode \`666\` and \`umask 027\` in case ${id}, derive the final permission bits and explain which groups lose which bits.`,
		correctAnswer: "640",
		explanation: "The umask removes group write and all other bits from the requested file mode, leaving 640.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["Default permissions", "umask"],
		difficulty: "medium",
	});
}

function makeLinuxFakeMediumRecallQuestion(id: string): Question {
	const variants = [
		{
			questionText: `Explain why \`ls -a\` shows dotfiles while plain \`ls\` does not in case ${id}.`,
			correctAnswer: "`-a` includes entries whose names begin with `.`.",
			explanation: "`ls -a` includes hidden dotfiles; plain `ls` omits them.",
			sourceSubtopics: ["Shell wildcard characters", "ls options"],
		},
		{
			questionText: `In \`ls -l | less\`, explain what the pipe connects and why the output becomes page-scrollable in case ${id}.`,
			correctAnswer: "The pipe connects stdout of `ls -l` to stdin of `less`.",
			explanation: "`less` reads the listing from stdin and displays it page by page.",
			sourceSubtopics: ["Redirection, Pipes and Filters", "less"],
		},
		{
			questionText: `Given \`chmod 755 script.sh\`, explain which user classes can execute the file in case ${id}.`,
			correctAnswer: "Owner, group, and others can execute it.",
			explanation: "The execute bit is set in 7, 5, and 5.",
			sourceSubtopics: ["Default permissions", "chmod"],
		},
		{
			questionText: `Compare \`kill PID\` and \`kill -9 PID\`: which one sends SIGKILL in case ${id}?`,
			correctAnswer: "`kill -9 PID` sends SIGKILL.",
			explanation: "Signal number 9 is SIGKILL; plain `kill` sends SIGTERM by default.",
			sourceSubtopics: ["Processes and signals"],
		},
	];
	const variant = pickVariant(variants, id);
	return makeQuestion({
		id,
		...variant,
		sourceTopics: ["Linux Commands"],
		difficulty: "medium",
	});
}

function makeLinuxSimplePredictionQuestion(id: string): Question {
	const variants = [
		{
			questionText: `Predict what \`echo "$HOME"\` versus \`echo '$HOME'\` prints in case ${id}.`,
			options: [
				"Double quotes expand HOME; single quotes keep `$HOME` literal",
				"Both commands print `$HOME` literally",
				"Both commands print the home directory path",
				"Single quotes expand HOME; double quotes keep it literal",
			],
			correctAnswer: "Double quotes expand HOME; single quotes keep `$HOME` literal",
			explanation: "The shell expands variables inside double quotes but not inside single quotes.",
			sourceSubtopics: ["quoting", "shell expansion"],
		},
		{
			questionText: `What does \`echo *.txt\` expand to when the directory contains \`a.txt\`, \`b.txt\`, and \`notes.md\` in case ${id}?`,
			options: [
				"`a.txt b.txt`",
				"`*.txt`",
				"`a.txt b.txt notes.md`",
				"`notes.md`",
			],
			correctAnswer: "`a.txt b.txt`",
			explanation: "The shell expands `*.txt` to matching pathnames before `echo` runs.",
			sourceSubtopics: ["Shell wildcard characters", "globbing"],
		},
		{
			questionText: `Predict the result of \`pwd\` after running \`cd /tmp\` in case ${id}.`,
			options: ["/tmp", "$HOME", "/", "The previous directory"],
			correctAnswer: "/tmp",
			explanation: "`cd /tmp` changes the current working directory for that shell.",
			sourceSubtopics: ["Paths", "cd", "pwd"],
		},
	];
	const variant = pickVariant(variants, id);
	return makeQuestion({
		id,
		...variant,
		sourceTopics: ["Linux Commands"],
		difficulty: "medium",
	});
}

function makeLinuxBasicSectionQuestion(id: string): Question {
	const variants = [
		{
			questionText: `Compare SSH key-based login with password login in case ${id}. Why is key-based login preferred?`,
			correctAnswer: "Key-based login avoids sending or reusing a password and supports stronger authentication.",
			explanation: "The note recommends SSH with keys and treats insecure remote login commands as deprecated.",
			sourceSubtopics: ["Login"],
		},
		{
			questionText: `Explain how \`uname -o\`, \`uname -r\`, and \`uname -m\` differ in case ${id}.`,
			correctAnswer: "`-o` prints OS, `-r` prints kernel release, and `-m` prints hardware architecture.",
			explanation: "These are direct `uname` option meanings from the note.",
			sourceSubtopics: ["uname"],
		},
		{
			questionText: `Compare \`/dev/pts/6\`, \`/dev/tty1\`, and \`/dev/ttyS0\` in case ${id}. What session type does each indicate?`,
			correctAnswer: "pts is a pseudo-terminal, tty is a tele terminal, and ttyS is a serial console.",
			explanation: "This is direct session-identification mapping.",
			sourceSubtopics: ["Session identification"],
		},
		{
			questionText: `Compare \`who -u\`, \`w\`, and \`last\` in case ${id}. Which ones show current sessions versus session history?`,
			correctAnswer: "`who -u` and `w` show current sessions; `last` shows login history.",
			explanation: "The commands are listed in the other-sessions and session-history sections.",
			sourceSubtopics: ["Other sessions", "Session history"],
		},
		{
			questionText: `Explain when \`man 5 passwd\` should be used instead of plain \`man passwd\` in case ${id}.`,
			correctAnswer: "`man 5 passwd` selects the file-format manual page rather than the command page.",
			explanation: "Manual sections disambiguate command, system-call, library, and file-format pages.",
			sourceSubtopics: ["Manual pages"],
		},
	];
	const variant = pickVariant(variants, id);
	return makeQuestion({
		id,
		...variant,
		sourceTopics: ["Linux Commands"],
		difficulty: "hard",
	});
}

function makeLinuxFakeHardOptionQuestion(id: string): Question {
	const correct = "find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l";
	return makeQuestion({
		id,
		questionText: [
			`Given case ${id}: a directory tree may contain spaces in filenames and permission-denied subdirectories.`,
			"Which command sequence correctly counts `ERROR` lines in `.log` files modified in the last 7 days while keeping stderr out of the count?",
		].join(" "),
		options: [
			correct,
			"find . -name *.log -mtime -7 | xargs grep ERROR 2>/dev/null | wc -l",
			"grep -R ERROR *.log 2>&1 | wc -l",
			"ls -R | grep '.log' | xargs grep ERROR | wc -l",
		],
		correctAnswer: correct,
		explanation: "The correct option uses null-delimited paths and redirects stderr before the pipe.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["find", "xargs", "quoting", "stderr redirection", "pipes"],
		difficulty: "hard",
	});
}

function makeLinuxWeakHardQuestion(id: string): Question {
	return makeQuestion({
		id,
		questionText: [
			`In Linux shell case ${id}, compare \`grep error app.log\` with \`grep -i error app.log\`.`,
			"Which explanation best describes the difference?",
		].join(" "),
		options: [
			"`grep -i` ignores case, so it can match `ERROR` as well as `error`",
			"`grep -i` searches recursively through directories by default",
			"`grep -i` redirects stderr away from the terminal",
			"`grep -i` prints only the number of matching lines",
		],
		correctAnswer: "`grep -i` ignores case, so it can match `ERROR` as well as `error`",
		explanation: "This is a direct option-purpose distinction, not multi-step shell reasoning.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["grep option recall"],
		difficulty: "hard",
	});
}

function makeNetworkHardQuestion(id: string): Question {
	const correct = "RTO fires, cwnd is cut aggressively, then the sender retransmits the missing segment after the timer";
	return makeQuestion({
		id,
		questionText: [
			`Given TCP case ${id}: a sender transmits segments 10-14, segment 10 is lost, and no later duplicate ACKs arrive because the receiver window closes immediately after segment 11.`,
			"Trace the sender state, identify whether fast retransmit or retransmission timeout fires, and explain how the congestion window changes compared with a duplicate-ACK recovery.",
		].join(" "),
		options: [
			correct,
			"Fast retransmit fires immediately, cwnd stays unchanged, and segment 10 is resent after three duplicate ACKs",
			"DNS cache expiry forces the sender to reopen the TCP connection before retransmitting",
			"The receiver retransmits segment 10 because TCP recovery is receiver-driven",
		],
		correctAnswer: correct,
		explanation: "With no stream of duplicate ACKs, fast retransmit has no evidence to trigger; the sender waits for RTO, backs off congestion state, and retransmits.",
		sourceTopics: ["Intro Networks"],
		sourceSubtopics: ["TCP retransmission", "congestion control", "failure mode"],
		difficulty: "hard",
	});
}

function makeRepeatedLinuxFindHardQuestion(id: string): Question {
	return makeQuestion({
		id,
		questionText: [
			`Given repeated find/xargs case ${id}: a directory tree may contain spaces in filenames and permission-denied subdirectories.`,
			"Construct the safest one-line command to find `.log` files modified in the last 7 days, count matching lines containing `ERROR`, and keep stderr out of the count.",
			"A teammate's attempt inflated the count with permission-denied text and split filenames with spaces; debug that failure mode. Which command sequence and explanation is correct?",
		].join(" "),
		options: [
			"`find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l`, because null-delimited paths preserve spaces and `2>/dev/null` removes find errors before the pipe",
			"`find . -name *.log -mtime -7 | xargs grep ERROR 2>/dev/null | wc -l`, because the shell expands `*.log` recursively and xargs preserves spaces by default",
			"`grep -R ERROR *.log 2>&1 | wc -l`, because merging stderr into stdout keeps permission errors out of the count",
			"`ls -R | grep '.log' | xargs grep ERROR | wc -l`, because listing names is equivalent to passing file paths from find",
		],
		correctAnswer: "`find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l`, because null-delimited paths preserve spaces and `2>/dev/null` removes find errors before the pipe",
		explanation: "Null-delimited output preserves paths with spaces, stderr is redirected before the pipe, and grep receives only safe file arguments.",
		sourceTopics: ["Linux Commands"],
		sourceSubtopics: ["find", "xargs", "quoting", "stderr redirection", "pipes"],
		difficulty: "hard",
	});
}

function makeLinuxHardQuestion(id: string): Question {
	const variants = [
		{
			questionText: [
				`Given case ${id}: a directory tree may contain spaces in filenames and permission-denied subdirectories.`,
				"Construct the safest one-line command to find `.log` files modified in the last 7 days, count matching lines containing `ERROR`, and keep stderr out of the count.",
				"A teammate's attempt inflated the count with permission-denied text and split filenames with spaces; debug that failure mode. Which command sequence and explanation is correct?",
			].join(" "),
			options: [
				"`find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l`, because null-delimited paths preserve spaces and `2>/dev/null` removes find errors before the pipe",
				"`find . -name *.log -mtime -7 | xargs grep ERROR 2>/dev/null | wc -l`, because the shell expands `*.log` recursively and xargs preserves spaces by default",
				"`grep -R ERROR *.log 2>&1 | wc -l`, because merging stderr into stdout keeps permission errors out of the count",
				"`ls -R | grep '.log' | xargs grep ERROR | wc -l`, because listing names is equivalent to passing file paths from find",
			],
			correctAnswer: "`find . -name '*.log' -mtime -7 -print0 2>/dev/null | xargs -0 grep -h 'ERROR' | wc -l`, because null-delimited paths preserve spaces and `2>/dev/null` removes find errors before the pipe",
			explanation: "Null-delimited output preserves paths with spaces, stderr is redirected before the pipe, and grep receives only safe file arguments.",
			sourceSubtopics: ["find", "xargs", "quoting", "stderr redirection", "pipes"],
		},
		{
			questionText: [
				`Given case ${id}: compare \`cmd >out 2>&1\` with \`cmd 2>&1 >out\` when stdout initially points to the terminal.`,
				"Predict where stdout and stderr end up, and debug the failure mode where stderr unexpectedly stays on the terminal. Which explanation is correct?",
			].join(" "),
			options: [
				"The first sends both streams to `out`; the second sends stdout to `out` but leaves stderr on the old stdout because `2>&1` copied stdout before it changed",
				"They are identical because shell redirections are commutative and both streams are named before the command starts",
				"The first sends stdout to `out` and stderr to the terminal; the second sends both streams to `out`",
				"The second discards stderr because redirecting stdout after `2>&1` closes file descriptor 2",
			],
			correctAnswer: "The first sends both streams to `out`; the second sends stdout to `out` but leaves stderr on the old stdout because `2>&1` copied stdout before it changed",
			explanation: "Redirections apply left to right, so `2>&1` duplicates the current stdout destination at that moment.",
			sourceSubtopics: ["redirection order", "stdout", "stderr", "file descriptors"],
		},
		{
			questionText: [
				`Given case ${id}: \`umask 027\`, then \`mkdir -m 777 project\`, then \`touch project/run.sh\`, then \`chmod 750 project/run.sh\`.`,
				"Trace the directory and file modes after each operation, derive which operation is affected by umask, and debug the mistaken belief that umask changes the later chmod result.",
			].join(" "),
			options: [
				"The directory creation is masked to `750`; the file creation would start from file defaults masked by `027`; the later `chmod 750` explicitly sets the file mode afterward",
				"The directory creation ignores umask; the file is created as `777`; the later chmod is then masked down to `730`",
				"umask only applies to chmod, so both creations keep their requested modes until the final mode becomes `730`",
				"umask permanently changes the directory, so every later file inside it loses group execute and all other bits regardless of chmod",
			],
			correctAnswer: "The directory creation is masked to `750`; the file creation would start from file defaults masked by `027`; the later `chmod 750` explicitly sets the file mode afterward",
			explanation: "Umask affects creation-time requested modes; chmod is an explicit later mode change and is not masked again.",
			sourceSubtopics: ["umask", "chmod", "directory permissions", "creation modes"],
		},
		{
			questionText: [
				`Given case ${id}: \`{ printf "a\\nb\\n"; printf "warn\\n" >&2; } 2>producer.err | grep b >out.txt 2>grep.err\`.`,
				"Predict terminal output and the contents of all three files, then explain which process each redirection applies to.",
				"Debug why the tempting belief that both error files stay empty fails.",
			].join(" "),
			options: [
				"Terminal prints nothing; `producer.err` contains `warn`; `out.txt` contains `b`; `grep.err` is empty",
				"Terminal prints `warn`; `out.txt` contains `b`; both error files are empty",
				"`producer.err` contains `b`; `out.txt` contains `warn`; `grep.err` is empty",
				"`grep.err` contains `warn`; `out.txt` contains `a` and `b`; terminal prints nothing",
			],
			correctAnswer: "Terminal prints nothing; `producer.err` contains `warn`; `out.txt` contains `b`; `grep.err` is empty",
			explanation: "The producer's stderr is redirected before the pipe, only producer stdout enters grep, grep stdout goes to `out.txt`, and grep stderr goes to `grep.err`.",
			sourceSubtopics: ["pipes", "stdout", "stderr", "process-local redirection"],
		},
	];
	const variant = pickVariant(variants, id);
	return makeQuestion({
		id,
		...variant,
		sourceTopics: ["Linux Commands"],
		difficulty: "hard",
	});
}

/**
 * Deterministic variant selection: a trailing number in the id picks the
 * variant directly, so diversity-sensitive tests control which scenario each
 * fixture uses; ids without digits fall back to the string hash.
 */
function pickVariant<T>(variants: T[], id: string): T {
	const digits = id.match(/(\d+)\s*$/)?.[1];
	const index = digits !== undefined
		? Number(digits) % variants.length
		: Math.abs(hashString(id)) % variants.length;
	return variants[index]!;
}

function makeQuestion(overrides: Partial<Question> = {}): Question {
	return {
		id: "q1",
		type: "mcq",
		questionText: "What should the learner recall?",
		options: ["A", "B", "C", "D"],
		correctAnswer: "A",
		explanation: "The invariant applies.",
		sourceTopics: ["Rotated binary search"],
		sourceSubtopics: [],
		difficulty: "medium",
		...overrides,
	};
}

function hashString(value: string): number {
	let hash = 0;
	for (const char of value) {
		hash = (hash * 31 + char.charCodeAt(0)) | 0;
	}
	return hash;
}

function makeResult(
	question: Question,
	overrides: Partial<QuizResult> = {}
): QuizResult {
	return {
		question,
		userAnswer: overrides.skipped ? "" : question.correctAnswer,
		isCorrect: true,
		skipped: false,
		timeTakenMs: 30_000,
		...overrides,
	};
}

function makeTopic(overrides: Partial<TopicNote> = {}): TopicNote {
	return {
		path: "cs/rotated-binary-search.md",
		title: "Rotated binary search",
		skill: 50,
		isPdf: false,
		createdAt: Date.UTC(2026, 5, 1),
		updatedAt: Date.UTC(2026, 5, 20),
		...overrides,
	};
}

function makeNoteState(
	topic: TopicNote,
	overrides: Partial<PracticeMemory["notes"][string]> = {}
): PracticeMemory["notes"][string] {
	return {
		path: topic.path,
		title: topic.title,
		skill: topic.skill,
		createdAt: topic.createdAt ?? 0,
		updatedAt: topic.updatedAt ?? 0,
		lastPracticedAt: 0,
		dueAt: 0,
		attempts: 0,
		correct: 0,
		skipped: 0,
		correctStreak: 0,
		stabilityDays: 0,
		averageTimeMs: 0,
		lastSessionAccuracy: 0,
		lastSessionFluency: 0,
		practicedSubtopics: {},
		...overrides,
	};
}

function makeIndexEntry(overrides: Partial<NoteIndexEntry> = {}): NoteIndexEntry {
	const createdAt = Date.UTC(2026, 5, 1);
	const updatedAt = Date.UTC(2026, 5, 20);
	return {
		path: "notes/example.md",
		title: "Example note",
		extension: "md",
		isPdf: false,
		frontmatter: {},
		tags: [],
		links: [],
		headings: [],
		media: [],
		estimatedWordCount: 12,
		size: 1024,
		skill: 50,
		createdAt,
		updatedAt,
		fileCreatedAt: createdAt,
		fileUpdatedAt: updatedAt,
		indexedAt: Date.UTC(2026, 5, 26),
		...overrides,
	};
}

function makeStructure(overrides: Partial<NoteStructure> = {}): NoteStructure {
	const sections = overrides.sections ?? [
		{
			heading: "Body",
			level: 0,
			content: "A compact note section.",
			wordCount: 4,
		},
	];
	return {
		path: "notes/example.md",
		title: "Example note",
		frontmatter: {},
		tags: [],
		links: [],
		headings: sections.map((section) => ({
			heading: section.heading,
			level: section.level,
		})),
		sections,
		cleanedText: sections.map((section) => section.content).join("\n\n"),
		media: [],
		createdAt: Date.UTC(2026, 5, 1),
		updatedAt: Date.UTC(2026, 5, 20),
		contentHash: "test",
		...overrides,
	};
}

function makeRemoteImageMedia(url: string): NoteMediaReference {
	return {
		path: url,
		alt: "Flowchart",
		caption: "A diagram from the imported article.",
		kind: "image",
		mimeType: "image/*",
		size: 0,
		source: "remote",
		url,
	};
}

function makeArrayBuffer(bytes: number[]): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.length);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

test("computeSkillDeltas keeps same-titled notes on distinct paths independent", () => {
	const weak = makeTopic({ path: "a/Shared.md", title: "Shared", skill: 40 });
	const strong = makeTopic({ path: "b/Shared.md", title: "Shared", skill: 80 });
	const question = makeQuestion({
		difficulty: "medium",
		sourceTopics: ["Shared"],
	});

	const deltas = computeSkillDeltas(
		[weak, strong],
		[makeResult(question, { isCorrect: true, timeTakenMs: 40_000 })]
	);
	const weakDelta = deltas.find((d) => d.path === "a/Shared.md");
	const strongDelta = deltas.find((d) => d.path === "b/Shared.md");

	assert.ok(weakDelta);
	assert.ok(strongDelta);
	assert.equal(weakDelta.before, 40);
	assert.equal(strongDelta.before, 80);
	// Each note's update is computed from its own skill, not collapsed by title.
	assert.ok(weakDelta.after > 40);
	assert.ok(strongDelta.after > 80);
	assert.notEqual(weakDelta.after, strongDelta.after);
});

test("extractSections ignores headings inside fenced code blocks", () => {
	const content = [
		"# Real heading",
		"intro text",
		"```python",
		"# this is a comment, not a heading",
		"def f():",
		"    return 1",
		"```",
		"closing text",
	].join("\n");

	const sections = extractSections(content);
	const headings = sections.map((section) => section.heading);
	assert.ok(headings.includes("Real heading"));
	assert.ok(!headings.includes("this is a comment, not a heading"));
});

test("checkAnswer falls back to tolerance when a non-integer answer is mislabeled integer", () => {
	const question = makeQuestion({
		type: "integer",
		options: undefined,
		correctAnswer: "3.5",
	});
	assert.equal(checkAnswer(question, "3.5"), true);
	assert.equal(checkAnswer(question, "3"), false);
});

test("remapPath rewrites exact files and folder prefixes only", () => {
	assert.equal(remapPath("a/n.md", "a/n.md", "b/n.md", false), "b/n.md");
	assert.equal(remapPath("a/n.md", "x/n.md", "b/n.md", false), null);
	assert.equal(remapPath("old/sub/n.md", "old", "new", true), "new/sub/n.md");
	assert.equal(remapPath("old", "old", "new", true), "new");
	assert.equal(remapPath("other/n.md", "old", "new", true), null);
});

test("migratePracticeMemoryPaths re-keys note and index state on rename", () => {
	const memory = normalizePracticeMemory(undefined);
	const topic = makeTopic({ path: "old/note.md", title: "Note" });
	memory.notes["old/note.md"] = makeNoteState(topic, { skill: 73, attempts: 4 });
	memory.index["old/note.md"] = makeIndexEntry({ path: "old/note.md", skill: 73 });

	const changed = migratePracticeMemoryPaths(memory, "old/note.md", "new/note.md", false);

	assert.equal(changed, true);
	assert.equal(memory.notes["old/note.md"], undefined);
	assert.equal(memory.index["old/note.md"], undefined);
	assert.equal(memory.notes["new/note.md"]?.skill, 73);
	assert.equal(memory.notes["new/note.md"]?.path, "new/note.md");
	assert.equal(memory.index["new/note.md"]?.path, "new/note.md");
});

test("migratePracticeMemoryPaths remaps every note under a renamed folder", () => {
	const memory = normalizePracticeMemory(undefined);
	for (const name of ["one.md", "two.md"]) {
		const path = `DSA/${name}`;
		memory.notes[path] = makeNoteState(makeTopic({ path, title: name }));
	}
	memory.notes["Other/keep.md"] = makeNoteState(makeTopic({ path: "Other/keep.md" }));

	const changed = migratePracticeMemoryPaths(memory, "DSA", "Algorithms", true);

	assert.equal(changed, true);
	assert.ok(memory.notes["Algorithms/one.md"]);
	assert.ok(memory.notes["Algorithms/two.md"]);
	assert.equal(memory.notes["DSA/one.md"], undefined);
	assert.ok(memory.notes["Other/keep.md"]);
});

test("prunePracticeMemoryPaths drops state for deleted files and folders", () => {
	const memory = normalizePracticeMemory(undefined);
	memory.notes["gone/a.md"] = makeNoteState(makeTopic({ path: "gone/a.md" }));
	memory.notes["gone/b.md"] = makeNoteState(makeTopic({ path: "gone/b.md" }));
	memory.notes["stay/c.md"] = makeNoteState(makeTopic({ path: "stay/c.md" }));
	memory.index["gone/a.md"] = makeIndexEntry({ path: "gone/a.md" });

	assert.equal(prunePracticeMemoryPaths(memory, "gone", true), true);
	assert.equal(memory.notes["gone/a.md"], undefined);
	assert.equal(memory.notes["gone/b.md"], undefined);
	assert.equal(memory.index["gone/a.md"], undefined);
	assert.ok(memory.notes["stay/c.md"]);
});

test("pdf skill paths migrate on rename and prune on delete", () => {
	const renameSkills: Record<string, number> = { "old/book.pdf": 62 };
	assert.equal(migratePdfSkillPaths(renameSkills, "old/book.pdf", "new/book.pdf", false), true);
	assert.equal(renameSkills["old/book.pdf"], undefined);
	assert.equal(renameSkills["new/book.pdf"], 62);

	const deleteSkills: Record<string, number> = { "refs/book.pdf": 40, "keep/x.pdf": 10 };
	assert.equal(prunePdfSkillPaths(deleteSkills, "refs", true), true);
	assert.equal(deleteSkills["refs/book.pdf"], undefined);
	assert.equal(deleteSkills["keep/x.pdf"], 10);
});

test("normalizeObsidianMath converts LaTeX-native delimiters to Obsidian forms", () => {
	assert.equal(normalizeObsidianMath("inline \\(a+b\\) end"), "inline $a+b$ end");
	assert.equal(normalizeObsidianMath("display \\[a+b\\] done"), "display $$a+b$$ done");
	assert.equal(normalizeObsidianMath("already $x$ and $$y$$"), "already $x$ and $$y$$");
	assert.equal(normalizeObsidianMath("plain text"), "plain text");
});

test("parseQuestions normalizes MCQ math delimiters while preserving correctness", () => {
	const payload = JSON.stringify([
		{
			id: "q1",
			type: "mcq",
			questionText: "Compute \\(x^2\\) when x=3",
			options: ["\\(9\\)", "\\(6\\)", "\\(12\\)", "\\(3\\)"],
			correctAnswer: "\\(9\\)",
			explanation: "Because \\(3^2 = 9\\).",
			sourceTopics: ["Math"],
			difficulty: "easy",
		},
	]);
	const [question] = parseQuestions(payload);
	assert.ok(question);
	assert.ok(question.questionText.includes("$x^2$"));
	assert.ok(!question.questionText.includes("\\("));
	assert.ok(question.options?.every((option) => /^\$.*\$$/.test(option)));
	assert.ok(question.options?.includes(question.correctAnswer));
});

test("parseQuestions normalizes math in numeric stems but leaves the answer numeric", () => {
	const payload = JSON.stringify([
		{
			id: "q1",
			type: "integer",
			questionText: "Evaluate \\(2 + 3\\).",
			correctAnswer: "5",
			explanation: "\\(2 + 3 = 5\\)",
			sourceTopics: ["Math"],
			difficulty: "easy",
		},
	]);
	const [question] = parseQuestions(payload);
	assert.ok(question);
	assert.equal(question.type, "integer");
	assert.equal(question.correctAnswer, "5");
	assert.ok(question.questionText.includes("$2 + 3$"));
});

test("detectFormatIssues flags raw LaTeX delimiters and clears after normalization", () => {
	const bad = makeQuestion({
		questionText: "x equals \\(y\\)",
		options: ["\\(1\\)", "2", "3", "4"],
		correctAnswer: "\\(1\\)",
	});
	assert.ok(detectFormatIssues(bad).latexDelimiters > 0);
	const fixed = detectFormatIssues(normalizeQuestionFormatting(bad));
	assert.equal(fixed.latexDelimiters, 0);
	assert.equal(fixed.unbalancedDollars, 0);
});

test("repairMathBraces closes missing closers and leaves ambiguity alone", () => {
	assert.equal(repairMathBraces("$\\frac{1}{2$"), "$\\frac{1}{2}$");
	assert.equal(repairMathBraces("$$\\sqrt{\\frac{a}{b$$"), "$$\\sqrt{\\frac{a}{b}}$$");
	// Extra closers are ambiguous; the span is left untouched.
	assert.equal(repairMathBraces("$x}$"), "$x}$");
	// Balanced math and plain money text pass through unchanged.
	assert.equal(repairMathBraces("$\\frac{1}{2}$ costs $5"), "$\\frac{1}{2}$ costs $5");
});

test("brace repair preserves MCQ option/answer equality", () => {
	const question = makeQuestion({
		questionText: "Evaluate $\\frac{1}{2$ of the interval.",
		options: ["$\\frac{1}{2$", "$1$", "$2$", "$4$"],
		correctAnswer: "$\\frac{1}{2$",
	});
	const normalized = normalizeQuestionFormatting(question);
	assert.equal(normalized.correctAnswer, "$\\frac{1}{2}$");
	assert.ok(normalized.options?.includes(normalized.correctAnswer));
	assert.equal(detectFormatIssues(normalized).unbalancedBraces, 0);
});

test("structured-output rejections are retryable, auth and quota errors are not", () => {
	assert.equal(isStructuredOutputRejection(400, "Invalid response_format: json_schema is not supported"), true);
	assert.equal(isStructuredOutputRejection(400, "responseSchema: unsupported field"), true);
	assert.equal(isStructuredOutputRejection(422, "strict mode rejected: additionalProperties"), true);
	assert.equal(isStructuredOutputRejection(400, "temperature must be between 0 and 2"), false);
	assert.equal(isStructuredOutputRejection(401, "invalid api key for schema access"), false);
	assert.equal(isStructuredOutputRejection(429, "rate limited json_schema"), false);
	assert.equal(isStructuredOutputRejection(500, "internal schema error"), false);
});

test("sampling params are omitted for models that removed them", () => {
	assert.equal(modelOmitsSamplingParams("claude-sonnet-5"), true);
	assert.equal(modelOmitsSamplingParams("claude-opus-4-7"), true);
	assert.equal(modelOmitsSamplingParams("claude-opus-4-8"), true);
	assert.equal(modelOmitsSamplingParams("claude-fable-5"), true);
	assert.equal(modelOmitsSamplingParams("claude-mythos-5"), true);
	// Older models keep the pinned temperature for output consistency.
	assert.equal(modelOmitsSamplingParams("claude-sonnet-4-6"), false);
	assert.equal(modelOmitsSamplingParams("claude-opus-4-6"), false);
	assert.equal(modelOmitsSamplingParams("claude-haiku-4-5"), false);
});

test("thinking is disabled everywhere except always-on models", () => {
	// Fable/Mythos think always-on and 400 on an explicit "disabled".
	assert.equal(modelHasAlwaysOnThinking("claude-fable-5"), true);
	assert.equal(modelHasAlwaysOnThinking("claude-mythos-5"), true);
	// Sonnet 5 runs adaptive thinking BY DEFAULT when the field is omitted —
	// it must receive an explicit disable or thinking eats the output budget.
	assert.equal(modelHasAlwaysOnThinking("claude-sonnet-5"), false);
	assert.equal(modelHasAlwaysOnThinking("claude-opus-4-8"), false);
	assert.equal(modelHasAlwaysOnThinking("claude-sonnet-4-6"), false);
	assert.equal(modelHasAlwaysOnThinking("claude-haiku-4-5-20251001"), false);
});

test("sampling and thinking rejections are retryable, auth errors are not", () => {
	assert.equal(isSamplingParamRejection(400, "temperature is deprecated for this model"), true);
	assert.equal(isSamplingParamRejection(400, "top_p is not supported"), true);
	assert.equal(isSamplingParamRejection(400, "messages: roles must alternate"), false);
	assert.equal(isSamplingParamRejection(401, "temperature invalid key"), false);
	assert.equal(isThinkingConfigRejection(400, "thinkingConfig.thinkingBudget: unknown field"), true);
	assert.equal(isThinkingConfigRejection(400, "responseSchema rejected"), false);
	assert.equal(isThinkingConfigRejection(429, "thinking rate limited"), false);
});

test("schemas order explanation before the answer fields", () => {
	for (const schema of [questionSchema(), geminiQuestionSchema()]) {
		const serialized = JSON.stringify(schema);
		const explanationAt = serialized.indexOf('"explanation"');
		const answerAt = serialized.indexOf('"correctAnswer"');
		assert.ok(explanationAt >= 0 && answerAt >= 0);
		assert.ok(
			explanationAt < answerAt,
			"explanation must precede correctAnswer so generation reasons before answering"
		);
	}
	const gemini = geminiQuestionSchema() as {
		properties: { questions: { items: Record<string, unknown> } };
	};
	const ordering = gemini.properties.questions.items["propertyOrdering"] as string[];
	assert.ok(ordering.indexOf("explanation") < ordering.indexOf("correctAnswer"));
});

test("gemini schema dialect avoids unsupported keywords", () => {
	const schema = geminiQuestionSchema();
	const serialized = JSON.stringify(schema);
	assert.ok(!serialized.includes("additionalProperties"));
	assert.ok(!serialized.includes('"null"'));
	const questions = (schema as { properties: { questions: { items: Record<string, unknown> } } })
		.properties.questions.items;
	const required = questions["required"] as string[];
	assert.ok(!required.includes("options"));
	const options = (questions["properties"] as Record<string, Record<string, unknown>>)["options"];
	assert.equal(options?.["nullable"], true);
});

test("answer-leak and near-duplicate-option questions are filtered out", () => {
	const leak = makeQuestion({
		id: "leak",
		questionText:
			"The pivot always lies in the unsorted half of the array, so which statement is true? The pivot always lies in the unsorted half of the array.",
		options: [
			"The pivot always lies in the unsorted half of the array",
			"The pivot always lies in the sorted half",
			"The pivot can lie in either half",
			"There is no pivot after rotation",
		],
		correctAnswer: "The pivot always lies in the unsorted half of the array",
	});
	const nearDuplicate = makeQuestion({
		id: "near-dupe",
		questionText: "Which complexity class fits the loop?",
		options: ["O(n log n)", "O(N LOG N)", "O(n)", "O(1)"],
		correctAnswer: "O(n)",
	});
	const clean = makeQuestion({
		id: "clean",
		questionText: "Given a rotated array, why does comparing with the right boundary locate the sorted half?",
		options: [
			"The right half is sorted when mid is less than the right boundary",
			"The left half is always sorted",
			"Rotation preserves global order",
			"The comparison sorts the array",
		],
		correctAnswer: "The right half is sorted when mid is less than the right boundary",
		sourceSubtopics: ["sorted-half detection"],
	});

	const kept = calibrateQuestionsForPractice(
		[leak, nearDuplicate, clean],
		[],
		[makeTopic({ title: "Rotated binary search" })]
	);
	assert.deepEqual(kept.map((question) => question.id), ["clean"]);
});

test("practice intent conditions the session calibration block", () => {
	const context = {
		note: makeTopic({ title: "Any note" }),
		content: "Some content.",
		history: "",
	};
	const cram = buildPrompt([context], 4, { intent: "cram", now: Date.UTC(2026, 5, 26) });
	assert.match(cram.userPrompt ?? "", /Learner intent: exam cram/);
	assert.match(cram.userPrompt ?? "", /high-yield facts/);

	const review = buildPrompt([context], 4, { intent: "review", now: Date.UTC(2026, 5, 26) });
	assert.match(review.userPrompt ?? "", /Learner intent: broad review/);

	const defaulted = buildPrompt([context], 4, { now: Date.UTC(2026, 5, 26) });
	assert.match(defaulted.userPrompt ?? "", /Learner intent: durable mastery/);
});

test("output token budget scales with question count within provider bounds", () => {
	const prompt = buildPrompt(
		[{ note: makeTopic({ title: "Any" }), content: "c", history: "" }],
		4,
		{ now: Date.UTC(2026, 5, 26) }
	);
	assert.equal(prompt.maxOutputTokens, 1200 + 4 * 800);
	assert.equal(outputTokenBudget(1), 2048);
	assert.equal(outputTokenBudget(20), 8192);
	assert.equal(outputTokenBudget(0), 2048);
	// The largest chunk a caller may send still fits under the shared ceiling.
	assert.ok(outputTokenBudget(8) <= 8192);
});

test("upfront chunk plan keeps every request under the provider ceiling", () => {
	assert.deepEqual(planUpfrontBatches(20), [7, 7, 6]);
	assert.deepEqual(planUpfrontBatches(9), [5, 4]);
	assert.deepEqual(planUpfrontBatches(8), [8]);
	assert.deepEqual(planUpfrontBatches(30), [8, 8, 7, 7]);
	for (const total of [9, 12, 16, 20, 25, 30]) {
		const plan = planUpfrontBatches(total);
		assert.equal(plan.reduce((sum, size) => sum + size, 0), total);
		assert.ok(plan.every((size) => size <= 8 && size >= 2));
	}
});

test("large upfront sessions drain through chunked generation without duplicates", async () => {
	const topic = makeTopic({ title: "Any topic", skill: 60 });
	const config: SessionConfig = {
		topics: [topic],
		questionCount: 20,
		challengeMode: "steady",
		challengeReason: "chunk test",
	};
	let calls = 0;
	const client = {
		generateQuestions: (prompt: StructuredPrompt): Promise<Question[]> => {
			calls += 1;
			const match = prompt.textPrompt.match(/Generate exactly (\d+) questions/);
			const size = Number(match?.[1] ?? 0);
			// Every chunked request must fit the ceiling on its own.
			assert.ok(size <= 8 && size > 0, `chunk of ${size} exceeds the per-request cap`);
			const call = calls;
			return Promise.resolve(Array.from({ length: size }, (_, index) =>
				makeQuestion({
					id: `c${call}-${index}`,
					questionText: `Given chunk scenario c${call}-${index}, trace the state change across steps and explain why the naive shortcut fails.`,
					correctAnswer: `answer c${call}-${index}`,
					sourceTopics: [topic.title],
					sourceSubtopics: [`subtopic c${call}-${index}`],
					difficulty: "medium",
				})
			));
		},
	};
	const contexts = [makeTopicContext(topic, "Content with enough substance to question.")];
	const generator = new FlowSessionGenerator(
		client,
		contexts,
		config,
		{},
		planUpfrontBatches(config.questionCount)
	);
	const all: Question[] = [];
	let batch = await generator.firstBatch();
	while (batch.length > 0) {
		all.push(...batch);
		if (generator.exhausted) break;
		batch = await generator.nextBatch([], all);
	}
	assert.equal(all.length, 20);
	assert.equal(new Set(all.map((question) => question.id)).size, 20);
	assert.equal(calls, 3);
});

test("bare == comparisons are backtick-wrapped in prose but not inside code or math", () => {
	assert.equal(
		escapeBareHighlights("triggering when arr[low]==arr[mid]==arr[high], the skip fires"),
		"triggering when `arr[low]==arr[mid]==arr[high]`, the skip fires"
	);
	// Already-protected spans stay untouched.
	assert.equal(
		escapeBareHighlights("check `a==b` first"),
		"check `a==b` first"
	);
	assert.equal(
		escapeBareHighlights("```python\nif a==b: pass\n```"),
		"```python\nif a==b: pass\n```"
	);
	assert.equal(escapeBareHighlights("$x==y$ holds"), "$x==y$ holds");
	// A lone == token still gets wrapped so it cannot pair into a highlight.
	assert.equal(escapeBareHighlights("a == b"), "a `==` b");
	assert.equal(escapeBareHighlights("no comparisons here"), "no comparisons here");
});

test("highlight escaping keeps option and correctAnswer strings equal", () => {
	const question = makeQuestion({
		questionText: "The skip fires when arr[low]==arr[mid]==arr[high].",
		options: [
			"only when low==high",
			"whenever arr[low]==arr[mid]==arr[high]",
			"never",
			"when mid==0",
		],
		correctAnswer: "whenever arr[low]==arr[mid]==arr[high]",
	});
	const normalized = normalizeQuestionFormatting(question);
	assert.equal(
		normalized.questionText,
		"The skip fires when `arr[low]==arr[mid]==arr[high]`."
	);
	assert.ok(normalized.options!.includes(normalized.correctAnswer));
	assert.equal(normalized.correctAnswer, "whenever `arr[low]==arr[mid]==arr[high]`");
});

test("answer verification prompt is blind and self-describing", () => {
	const questions = [
		makeQuestion({
			id: "v1",
			questionText: "Which invariant holds?",
			correctAnswer: "A",
			explanation: "Because the unsorted half contains the pivot.",
		}),
		makeQuestion({
			id: "v2",
			type: "integer",
			options: undefined,
			questionText: "How many comparisons occur?",
			correctAnswer: "17",
			explanation: "Count the halvings.",
		}),
	];
	const base: StructuredPrompt = {
		textPrompt: "SYSTEM\n\nGenerate exactly 2 questions",
		systemPrompt: "SYSTEM",
		userPrompt: "Generate exactly 2 questions",
		maxOutputTokens: 2800,
		attachments: [],
	};
	const prompt = buildAnswerVerificationPrompt(base, questions);
	assert.match(prompt.userPrompt!, /## Answer verification/);
	assert.match(prompt.userPrompt!, /Which invariant holds\?/);
	// Blind: neither the marked answers nor the original reasoning may leak.
	assert.ok(!prompt.userPrompt!.includes("\"17\""));
	assert.ok(!prompt.userPrompt!.includes("unsorted half contains"));
	assert.ok(!prompt.userPrompt!.includes("Count the halvings"));
	assert.ok(!/"correctAnswer"/.test(prompt.userPrompt!.split("## Answer verification")[1] ?? ""));
});

test("answer verification drops only actively contested questions", () => {
	const original = [
		makeQuestion({ id: "k1", questionText: "Stem one?", correctAnswer: "A" }),
		makeQuestion({ id: "k2", questionText: "Stem two?", correctAnswer: "B" }),
		makeQuestion({ id: "k3", questionText: "Stem three?", correctAnswer: "C" }),
		makeQuestion({ id: "k4", questionText: "Stem four?", correctAnswer: "D" }),
	];
	// Verifier agrees on k1/k3, disagrees on k2, and never returned k4.
	const reSolved = [
		makeQuestion({ id: "k1", questionText: "Stem one?", correctAnswer: "A" }),
		makeQuestion({ id: "k2", questionText: "Stem two?", correctAnswer: "C" }),
		makeQuestion({ id: "k3", questionText: "Stem three?", correctAnswer: "C" }),
	];
	const kept = applyAnswerVerification(original, reSolved);
	assert.deepEqual(kept.map((question) => question.id), ["k1", "k3", "k4"]);
});

test("answer verification distrusts a verifier that contests most of the batch", () => {
	const original = [
		makeQuestion({ id: "m1", correctAnswer: "A" }),
		makeQuestion({ id: "m2", correctAnswer: "B" }),
		makeQuestion({ id: "m3", correctAnswer: "C" }),
		makeQuestion({ id: "m4", correctAnswer: "D" }),
	];
	const reSolved = original.map((question) =>
		makeQuestion({ id: question.id, correctAnswer: "wrong every time" })
	);
	assert.equal(applyAnswerVerification(original, reSolved).length, 4);
});

test("answer verification matches by stem when ids drift and respects multi set equality", () => {
	const original = [
		makeQuestion({
			id: "orig-1",
			type: "multi",
			questionText: "Select every property that holds.",
			options: ["P holds", "Q holds", "R holds", "S holds"],
			correctAnswers: ["P holds", "R holds"],
			correctAnswer: "P holds\nR holds",
		}),
	];
	// Verifier renumbered the id but re-solved the same stem; its display order
	// differs and that must not count as disagreement.
	const agreeing = [
		makeQuestion({
			id: "q1",
			type: "multi",
			questionText: "Select  every property that holds.",
			options: ["P holds", "Q holds", "R holds", "S holds"],
			correctAnswers: ["R holds", "P holds"],
			correctAnswer: "R holds\nP holds",
		}),
	];
	assert.equal(applyAnswerVerification(original, agreeing).length, 1);
	const disagreeing = [
		makeQuestion({
			id: "q1",
			type: "multi",
			questionText: "Select  every property that holds.",
			options: ["P holds", "Q holds", "R holds", "S holds"],
			correctAnswers: ["Q holds", "S holds"],
			correctAnswer: "Q holds\nS holds",
		}),
	];
	assert.equal(applyAnswerVerification(original, disagreeing).length, 0);
});

test("generateQuestionsFromClient runs the blind re-solve only when configured", async () => {
	const topic = makeTopic({ title: "Any topic", skill: 55 });
	const contexts = [makeTopicContext(topic, "Content with enough substance to question.")];
	const batch = [
		makeQuestion({
			id: "g1",
			questionText: "Trace the pointer updates for the stated array and pick the invariant-preserving step.",
			correctAnswer: "A",
			sourceTopics: [topic.title],
			sourceSubtopics: ["pointer updates"],
		}),
		makeQuestion({
			id: "g2",
			questionText: "A colleague proposes skipping the boundary check entirely; explain which failure mode that introduces.",
			correctAnswer: "B",
			sourceTopics: [topic.title],
			sourceSubtopics: ["boundary check"],
		}),
	];
	const config: SessionConfig = {
		topics: [topic],
		questionCount: 2,
		challengeMode: "steady",
		challengeReason: "verify test",
		verifyAnswers: true,
	};
	const prompt: StructuredPrompt = {
		textPrompt: "SYSTEM\n\nGenerate exactly 2 questions",
		systemPrompt: "SYSTEM",
		userPrompt: "Generate exactly 2 questions",
		maxOutputTokens: 2800,
		attachments: [],
	};
	// Second call is the verification: it disagrees on g2.
	const client = makeBatchClient([
		batch,
		[
			makeQuestion({ ...batch[0]! }),
			makeQuestion({ ...batch[1]!, correctAnswer: "C" }),
		],
	]);
	const verified = await generateQuestionsFromClient(client, prompt, config, contexts);
	assert.equal(client.calls.length, 2);
	assert.match(client.calls[1]!.userPrompt!, /## Answer verification/);
	assert.deepEqual(verified.map((question) => question.id), ["g1"]);

	// Without the flag the same run never issues a second request.
	const unverifiedClient = makeBatchClient([batch.map((question) => makeQuestion({ ...question }))]);
	const unverified = await generateQuestionsFromClient(
		unverifiedClient,
		prompt,
		{ ...config, verifyAnswers: undefined },
		contexts
	);
	assert.equal(unverifiedClient.calls.length, 1);
	assert.equal(unverified.length, 2);
});

test("analytical moves catalog is domain-general and fully rendered into the system prompt", () => {
	const keys = ANALYTICAL_MOVES.map((move) => move.key);
	assert.equal(new Set(keys).size, keys.length, "move keys must be unique");
	const guidance = renderAnalyticalMovesGuidance();
	for (const move of ANALYTICAL_MOVES) {
		assert.ok(move.trigger.length > 0 && move.shape.length > 0);
		assert.ok(guidance.includes(move.name), `guidance must render ${move.key}`);
		// The de-specialization contract: moves key off structural features of
		// the material, never a subject. A named domain in a trigger or shape
		// means the move regressed into a topic gate.
		assert.ok(
			!/physics|chemistry|biolog|linux|shell|javascript|electr|algebra/i.test(
				`${move.trigger} ${move.shape}`
			),
			`move ${move.key} must stay domain-general`
		);
	}
	assert.match(guidance, /never name the move/);
	assert.match(guidance, /Easy questions do not use these/);

	const topic = makeTopic({ title: "Consensus protocols", skill: 70 });
	const prompt = buildPrompt(
		[makeTopicContext(topic, "Quorum intersection arguments and failure modes.")],
		4,
		{ now: Date.UTC(2026, 6, 5) }
	);
	assert.match(prompt.systemPrompt!, /## Analytical moves/);
	assert.match(prompt.systemPrompt!, /Approximation breakdown/);
	assert.match(prompt.systemPrompt!, /Minimal pair/);
	assert.match(prompt.systemPrompt!, /Flawed argument/);
});

test("deep authoring prompt embeds the target questions under minted ids", () => {
	const base: StructuredPrompt = {
		textPrompt: "SYSTEM\n\nGenerate exactly 3 questions",
		systemPrompt: "SYSTEM",
		userPrompt: "Generate exactly 3 questions",
		maxOutputTokens: 2800,
		attachments: [],
	};
	const questions = [
		makeQuestion({ id: "q1", difficulty: "easy", questionText: "Recall the definition." }),
		makeQuestion({ id: "q2", difficulty: "medium", questionText: "Why does the invariant survive the swap?" }),
		makeQuestion({ id: "q3", difficulty: "hard", questionText: "Which step of the proof fails on the degenerate input?" }),
	];
	const plan = buildDeepAuthoringPrompt(base, questions);
	assert.ok(plan);
	// Only medium/hard are sharpened, in order, under minted ids.
	assert.deepEqual(plan.targets.map((question) => question.id), ["q2", "q3"]);
	assert.match(plan.prompt.userPrompt!, /## Deep authoring pass/);
	assert.ok(plan.prompt.userPrompt!.includes('"id":"s1"'));
	assert.ok(plan.prompt.userPrompt!.includes('"id":"s2"'));
	// The regression that motivated this test: the questions themselves must
	// actually be present in the pass, not merely referred to.
	assert.ok(plan.prompt.userPrompt!.includes("Why does the invariant survive the swap?"));
	assert.ok(plan.prompt.userPrompt!.includes("Which step of the proof fails on the degenerate input?"));
	assert.ok(!plan.prompt.userPrompt!.includes("Recall the definition."));
	assert.ok(plan.prompt.textPrompt.includes("## Deep authoring pass"));
	assert.equal(plan.prompt.systemPrompt, "SYSTEM");

	assert.equal(
		buildDeepAuthoringPrompt(base, [makeQuestion({ difficulty: "easy" })]),
		null
	);
});

test("applyDeepAuthoring merges by minted id, pins id and difficulty, and never guesses", () => {
	const easy = makeQuestion({ id: "q1", difficulty: "easy" });
	const medium = makeQuestion({ id: "q2", difficulty: "medium", questionText: "Original medium stem?" });
	const hard = makeQuestion({ id: "q3", difficulty: "hard", questionText: "Original hard stem?" });
	const original = [easy, medium, hard];
	const targets = [medium, hard];

	// Minted-id path: a partial return replaces only its own original, and the
	// rewrite keeps the original id/difficulty even when the model drifted them.
	const merged = applyDeepAuthoring(original, targets, [
		makeQuestion({ id: "s2", difficulty: "medium", questionText: "Sharper hard stem?" }),
	]);
	assert.deepEqual(merged.map((question) => question.questionText), [
		easy.questionText,
		"Original medium stem?",
		"Sharper hard stem?",
	]);
	assert.equal(merged[2]!.id, "q3");
	assert.equal(merged[2]!.difficulty, "hard");

	// Renumbering model: no minted ids, exact count → positional recovery.
	const renumbered = applyDeepAuthoring(original, targets, [
		makeQuestion({ id: "q1", questionText: "Rewritten medium?" }),
		makeQuestion({ id: "q2", questionText: "Rewritten hard?" }),
	]);
	assert.equal(renumbered[1]!.questionText, "Rewritten medium?");
	assert.equal(renumbered[1]!.id, "q2");
	assert.equal(renumbered[2]!.questionText, "Rewritten hard?");

	// No minted ids AND count mismatch → ambiguous, keep everything.
	const ambiguous = applyDeepAuthoring(original, targets, [
		makeQuestion({ id: "q9", questionText: "Which original is this?" }),
	]);
	assert.deepEqual(ambiguous, original);

	// Duplicate model-assigned ids in a merged batch cannot cross-contaminate:
	// matching is by target object identity, not by the duplicated id.
	const dupeEasy = makeQuestion({ id: "q1", difficulty: "easy", questionText: "Easy twin." });
	const dupeMedium = makeQuestion({ id: "q1", difficulty: "medium", questionText: "Medium twin." });
	const dupeMerged = applyDeepAuthoring(
		[dupeEasy, dupeMedium],
		[dupeMedium],
		[makeQuestion({ id: "s1", questionText: "Sharper twin." })]
	);
	assert.equal(dupeMerged[0]!.questionText, "Easy twin.");
	assert.equal(dupeMerged[1]!.questionText, "Sharper twin.");
});

test("generateQuestionsFromClient sharpens before the blind re-solve when deep authoring is on", async () => {
	const topic = makeTopic({ title: "Any topic", skill: 55 });
	const contexts = [makeTopicContext(topic, "Content with enough substance to question.")];
	// Options carry real reasoning so the difficulty estimator keeps these at
	// medium+ — bare letter options would demote them out of the sharpen set.
	const reasonOptions = [
		"The rotation point must lie right of mid, so the minimum stays inside the kept half",
		"The left half is always the longer one, so discarding it converges in fewer iterations",
		"Comparing against `arr[hi]` sorts both halves, which makes plain binary search valid",
		"The loop only terminates when the array was never rotated in the first place",
	];
	const original = makeQuestion({
		id: "g1",
		questionText: "A sorted array is rotated once and searched with a loop comparing `arr[mid]` to `arr[hi]`. When `arr[mid] > arr[hi]`, why is discarding the left half safe?",
		options: [...reasonOptions],
		correctAnswer: reasonOptions[0]!,
		explanation: "If `arr[mid] > arr[hi]` the order breaks between mid and hi, so the rotation point and the minimum lie in that half.",
		sourceTopics: [topic.title],
		sourceSubtopics: ["rotation invariant"],
	});
	const sharpened = makeQuestion({
		id: "s1",
		questionText: "A colleague flips the loop's comparison to `arr[mid] > arr[lo]` on the same rotated array. Which invariant breaks first, and why does the minimum escape the kept half?",
		options: [...reasonOptions],
		correctAnswer: reasonOptions[0]!,
		explanation: "Comparing against `arr[lo]` no longer certifies which half contains the rotation point, so the minimum can be discarded.",
		sourceTopics: [topic.title],
		sourceSubtopics: ["rotation invariant"],
	});
	const config: SessionConfig = {
		topics: [topic],
		questionCount: 1,
		challengeMode: "steady",
		challengeReason: "deep authoring test",
		verifyAnswers: true,
		deepAuthoring: true,
	};
	const prompt: StructuredPrompt = {
		textPrompt: "SYSTEM\n\nGenerate exactly 1 questions",
		systemPrompt: "SYSTEM",
		userPrompt: "Generate exactly 1 questions",
		maxOutputTokens: 2800,
		attachments: [],
	};
	const client = makeBatchClient([
		[makeQuestion({ ...original })],
		[makeQuestion({ ...sharpened })],
		[makeQuestion({ ...sharpened, id: "g1" })],
	]);
	const result = await generateQuestionsFromClient(client, prompt, config, contexts);
	assert.equal(client.calls.length, 3);
	assert.match(client.calls[1]!.userPrompt!, /## Deep authoring pass/);
	assert.ok(client.calls[1]!.userPrompt!.includes(original.questionText));
	// The blind re-solve must run on the SHARPENED batch, not the originals.
	assert.match(client.calls[2]!.userPrompt!, /## Answer verification/);
	assert.ok(client.calls[2]!.userPrompt!.includes(sharpened.questionText));
	assert.equal(result.length, 1);
	assert.equal(result[0]!.id, "g1");
	assert.equal(result[0]!.questionText, sharpened.questionText);

	// A sharpen pass that returns nothing usable is a no-op, never a loss.
	const noopClient = makeBatchClient([
		[makeQuestion({ ...original })],
		[],
		[makeQuestion({ ...original })],
	]);
	const kept = await generateQuestionsFromClient(noopClient, prompt, config, contexts);
	assert.equal(kept.length, 1);
	assert.equal(kept[0]!.questionText, original.questionText);
});

test("system prompt carries the self-containment, no-link, and option-parity rules", () => {
	const topic = makeTopic({ title: "Smallest divisor", skill: 70 });
	const prompt = buildPrompt(
		[makeTopicContext(topic, "Binary search over divisors with a sum condition.")],
		4,
		{ now: Date.UTC(2026, 6, 4) }
	);
	assert.match(prompt.systemPrompt!, /self-contained AND terse/);
	assert.match(prompt.systemPrompt!, /One question = one ask/);
	assert.match(prompt.systemPrompt!, /Never write wikilinks or markdown links/);
	assert.ok(!prompt.systemPrompt!.includes("[[Exact Topic Title]]"));
	assert.match(prompt.systemPrompt!, /zero signal about which option is right/);
	assert.match(prompt.systemPrompt!, /values large or irregular enough that shortcuts fail/);
	assert.match(prompt.systemPrompt!, /renders as highlighted text in Obsidian/);
	assert.match(prompt.systemPrompt!, /contradicts anything the stem states/);
	// The format exemplar must not model the longest-option-is-correct bias
	// (or invented wikilinks) that the rules above forbid.
	const exemplar = prompt.systemPrompt!.slice(prompt.systemPrompt!.indexOf("One exemplar"));
	const options = [...exemplar.matchAll(/^\s{4}"(.+)",?$/gm)].map((match) => match[1]!);
	const answerMatch = exemplar.match(/"correctAnswer": "(.+)",/);
	assert.equal(options.length, 4);
	const words = (text: string): number => text.split(/\s+/).filter(Boolean).length;
	const correctWords = words(answerMatch![1]!);
	assert.ok(
		options.some((option) => option !== answerMatch![1] && words(option) >= correctWords),
		"exemplar correct option must not be strictly longest"
	);
	assert.ok(!exemplar.includes("[["));
});

test("cross-topic bridges surface only structurally connected session notes", () => {
	const packets = makeTopicContext(
		makeTopic({ title: "How data moves in packets", skill: 60 }),
		"Packets are routed independently and reassembled."
	);
	packets.structure = makeStructure({
		title: "How data moves in packets",
		tags: ["networking"],
		links: ["Circuit switching history"],
		sections: [
			{
				heading: "Statistical multiplexing tradeoff",
				level: 1,
				content: "Bursty traffic shares capacity; silence frees bandwidth for other flows.",
				wordCount: 11,
			},
		],
	});
	const circuits = makeTopicContext(
		makeTopic({ title: "Circuit switching history", skill: 55 }),
		"A dedicated path is reserved end to end."
	);
	circuits.structure = makeStructure({
		title: "Circuit switching history",
		tags: ["networking"],
		links: [],
		sections: [
			{
				heading: "Reserved paths",
				level: 1,
				content: "Capacity stays allocated during silence, guaranteeing order.",
				wordCount: 8,
			},
		],
	});
	const unrelated = makeTopicContext(
		makeTopic({ title: "Baroque counterpoint", skill: 50 }),
		"Voice leading rules for fugues."
	);
	unrelated.structure = makeStructure({
		title: "Baroque counterpoint",
		tags: ["music"],
		links: [],
		sections: [
			{
				heading: "Voice independence",
				level: 1,
				content: "Each voice keeps melodic identity within harmonic constraints.",
				wordCount: 9,
			},
		],
	});

	const connected = buildPrompt([packets, circuits], 6, { now: Date.UTC(2026, 6, 5) });
	assert.match(connected.userPrompt!, /## Cross-topic bridges/);
	assert.match(connected.userPrompt!, /the notes link to each other/);
	assert.match(connected.userPrompt!, /shared tags: networking/);
	assert.match(connected.userPrompt!, /1-2 synthesis questions/);

	const disconnected = buildPrompt([packets, unrelated], 6, { now: Date.UTC(2026, 6, 5) });
	assert.ok(!disconnected.userPrompt!.includes("## Cross-topic bridges"));

	const single = buildPrompt([packets], 6, { now: Date.UTC(2026, 6, 5) });
	assert.ok(!single.userPrompt!.includes("## Cross-topic bridges"));
});

test("format issues flag a correct option that is strictly longest", () => {
	const biased = makeQuestion({
		options: [
			"Wrong",
			"Also wrong",
			"Short wrong option",
			"The correct option, which carefully explains the entire mechanism with every qualification spelled out",
		],
		correctAnswer:
			"The correct option, which carefully explains the entire mechanism with every qualification spelled out",
	});
	assert.equal(detectFormatIssues(biased).correctLongestOption, 1);

	const balanced = makeQuestion({
		options: [
			"A distractor with comparable length and matching depth of reasoning here",
			"Another distractor with comparable length and matching depth of reasoning",
			"The correct option with comparable length and matching reasoning depth",
			"A third distractor with comparable length and matching depth of reasoning",
		],
		correctAnswer: "The correct option with comparable length and matching reasoning depth",
	});
	assert.equal(detectFormatIssues(balanced).correctLongestOption, 0);
});

test("daily selection reserves slots for new notes even under review backlog", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const reviewed = Array.from({ length: 10 }, (_, index) =>
		makeTopic({ path: `old/due-${index}.md`, title: `Due note ${index}` })
	);
	const fresh = Array.from({ length: 5 }, (_, index) =>
		makeTopic({ path: `new/fresh-${index}.md`, title: `Fresh note ${index}` })
	);
	const notes: Record<string, unknown> = {};
	for (const topic of reviewed) {
		notes[topic.path] = makeNoteState(topic, {
			attempts: 5,
			correct: 3,
			lastPracticedAt: now - 9 * DAY_MS,
			dueAt: now - DAY_MS,
			lastSessionAccuracy: 0.6,
		});
	}
	const memory = normalizePracticeMemory({
		version: 1,
		notes,
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: now,
		},
		questionFeedback: [],
	} as unknown as PracticeMemory);

	const selected = selectDailyTopics([...reviewed, ...fresh], memory, 6, now);
	const freshCount = selected.filter((topic) => topic.path.startsWith("new/")).length;
	const dueCount = selected.filter((topic) => topic.path.startsWith("old/")).length;
	assert.equal(selected.length, 6);
	// Old behavior: 6 due, 0 new. Now fresh material always gets a foothold.
	assert.equal(freshCount, 2);
	assert.equal(dueCount, 4);
});

test("flow batch plan opens small and avoids one-question round-trips", () => {
	assert.deepEqual(planFlowBatches(8), [3, 3, 2]);
	assert.deepEqual(planFlowBatches(7), [3, 2, 2]);
	assert.deepEqual(planFlowBatches(6), [3, 3]);
	assert.deepEqual(planFlowBatches(4), [4]);
	assert.deepEqual(planFlowBatches(3), [3]);
	assert.deepEqual(planFlowBatches(1), [1]);
	for (const total of [5, 6, 7, 8, 12, 20]) {
		const plan = planFlowBatches(total);
		assert.equal(plan.reduce((sum, size) => sum + size, 0), total);
		assert.ok(plan.every((size) => size >= 2) || total <= 1);
	}
});

test("flow controller holds the target band with hysteresis", () => {
	const fastCorrect = (): FlowSignal => ({
		isCorrect: true, skipped: false, timeTakenMs: 30_000, difficulty: "medium",
	});
	const miss = (): FlowSignal => ({
		isCorrect: false, skipped: false, timeTakenMs: 80_000, difficulty: "medium",
	});
	const skip = (): FlowSignal => ({
		isCorrect: false, skipped: true, timeTakenMs: 5_000, difficulty: "medium",
	});

	// Too few answers: no movement.
	assert.equal(flowSkillAdjustment([fastCorrect(), fastCorrect()]).skillDelta, 0);
	// Fast and accurate: step up.
	assert.ok(flowSkillAdjustment([fastCorrect(), fastCorrect(), fastCorrect(), fastCorrect()]).skillDelta > 0);
	// Struggling: step down.
	assert.ok(flowSkillAdjustment([miss(), miss(), fastCorrect(), miss()]).skillDelta < 0);
	// Two skips read as overload.
	assert.ok(flowSkillAdjustment([fastCorrect(), skip(), fastCorrect(), skip()]).skillDelta < 0);
	// Mid-band accuracy with slow answers: hold steady.
	const steady = flowSkillAdjustment([
		fastCorrect(), miss(), fastCorrect(), fastCorrect(),
		{ isCorrect: true, skipped: false, timeTakenMs: 170_000, difficulty: "medium" },
	]);
	assert.equal(steady.skillDelta, 0);
});

test("flow generator conditions later batches on session results", async () => {
	const topic = makeTopic({ title: "Any topic", skill: 60 });
	const config: SessionConfig = {
		topics: [topic],
		questionCount: 6,
		challengeMode: "steady",
		challengeReason: "flow test",
	};
	const makeBatch = (prefix: string): Question[] =>
		Array.from({ length: 3 }, (_, index) =>
			makeQuestion({
				id: `${prefix}-${index}`,
				questionText: `Given scenario ${prefix}-${index}, trace the state change across two steps and explain why the naive shortcut fails.`,
				correctAnswer: `answer ${prefix}-${index}`,
				sourceTopics: [topic.title],
				sourceSubtopics: [`subtopic ${prefix}-${index}`],
				difficulty: "medium",
			})
		);
	const prompts: string[] = [];
	const client = {
		generateQuestions: (prompt: StructuredPrompt): Promise<Question[]> => {
			prompts.push(prompt.textPrompt);
			return Promise.resolve(makeBatch(`b${prompts.length}`));
		},
	};
	const contexts = [makeTopicContext(topic, "Content about the topic with enough substance.")];
	const generator = new FlowSessionGenerator(client, contexts, config);

	const first = await generator.firstBatch();
	assert.equal(first.length, 3);
	assert.equal(generator.exhausted, false);

	const results = first.map((question) =>
		makeResult(question, { isCorrect: true, timeTakenMs: 20_000 })
	);
	const second = await generator.nextBatch(results, first);
	assert.equal(second.length, 3);
	assert.equal(generator.exhausted, true);
	// The continuation prompt carries the flow note and the asked stems.
	assert.match(prompts[1] ?? "", /Flow continuation/);
	assert.match(prompts[1] ?? "", /raising challenge after fast, accurate answers/);
	assert.match(prompts[1] ?? "", /Given scenario b1-0/);
	// No duplicates across batches.
	const ids = [...first, ...second].map((question) => question.id);
	assert.equal(new Set(ids).size, ids.length);
	// Exhausted generator returns nothing.
	assert.deepEqual(await generator.nextBatch(results, [...first, ...second]), []);
});

test("system prompt carries one format exemplar", () => {
	const prompt = buildPrompt(
		[
			{
				note: makeTopic({ title: "Any note" }),
				content: "Some content.",
				history: "",
			},
		],
		4,
		{ now: Date.UTC(2026, 5, 26) }
	);
	assert.match(prompt.systemPrompt ?? "", /One exemplar of the signature format/);
	assert.match(prompt.systemPrompt ?? "", /never its topic or phrasing/);
	// The exemplar demonstrates math, code, and reason-paired options.
	assert.match(prompt.systemPrompt ?? "", /\$O\(\\\\log n\)\$/);
	assert.ok(!/One exemplar of the signature format/.test(prompt.userPrompt ?? ""));
});

test("buildPrompt splits stable instructions into system and material into user", () => {
	const topic = makeTopic({ title: "Rotated binary search" });
	const prompt = buildPrompt(
		[
			{
				note: topic,
				content: "Binary search keeps the sorted-half invariant.",
				history: "",
			},
		],
		4,
		{ now: Date.UTC(2026, 5, 26) }
	);

	assert.ok(prompt.systemPrompt);
	assert.ok(prompt.userPrompt);
	// Stable HOW lives in the system prompt, not the per-session material.
	assert.match(prompt.systemPrompt ?? "", /Core learning contract/);
	assert.match(prompt.systemPrompt ?? "", /## Response format/);
	assert.ok(!/### Topic:/.test(prompt.systemPrompt ?? ""));
	// Per-session material lives in the user prompt.
	assert.match(prompt.userPrompt ?? "", /### Topic: Rotated binary search/);
	assert.match(prompt.userPrompt ?? "", /Generate exactly 4 questions now/);
	assert.ok(!/Core learning contract/.test(prompt.userPrompt ?? ""));

	const parts = resolvePromptParts(prompt);
	assert.equal(parts.system, prompt.systemPrompt);
	assert.equal(parts.user, prompt.userPrompt);

	// Fallback: a builder that only set textPrompt still yields a usable split.
	const fallback = resolvePromptParts({ textPrompt: "only text", attachments: [] });
	assert.equal(fallback.user, "only text");
	assert.match(fallback.system, /Adaptive Practice/);
});

test("questionSchema is shaped for strict structured output", () => {
	const schema = questionSchema();
	const questions = (schema["properties"] as Record<string, unknown>)["questions"] as Record<string, unknown>;
	const item = questions["items"] as {
		additionalProperties: unknown;
		required: string[];
		properties: Record<string, { type: unknown }>;
	};

	// Strict mode requires every property to be listed in `required`.
	assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
	assert.equal(item.additionalProperties, false);
	// Options nullable so numeric questions can omit them under strict.
	const optionsProp = item.properties["options"];
	assert.ok(optionsProp);
	assert.deepEqual(optionsProp.type, ["array", "null"]);
	// `minItems` is not supported by strict structured output.
	assert.ok(!("minItems" in questions));
});

test("normalizeQuestionFormatting links a repeated note only once per question", () => {
	const question = makeQuestion({
		type: "integer",
		options: undefined,
		questionText: "In [[version control]], the [[version control]] history graph is a DAG.",
		explanation: "A [[version control]] DAG records merges.",
		correctAnswer: "1",
	});
	const out = normalizeQuestionFormatting(question);
	assert.equal((out.questionText.match(/\[\[version control\]\]/g) ?? []).length, 1);
	assert.ok(out.questionText.includes("the version control history graph"));
	// Already linked in the stem, so the explanation mention is plain text.
	assert.ok(!out.explanation.includes("[[version control]]"));
	assert.ok(out.explanation.includes("A version control DAG"));
});

test("link dedupe handles markdown links and leaves image embeds intact", () => {
	const question = makeQuestion({
		type: "integer",
		options: undefined,
		questionText: "See [variance](Variance.md), then [variance](Variance.md) again, plus ![[plot.png]].",
		explanation: "",
		correctAnswer: "1",
	});
	const out = normalizeQuestionFormatting(question);
	assert.equal((out.questionText.match(/\]\(Variance\.md\)/g) ?? []).length, 1);
	assert.ok(out.questionText.includes("then variance again"));
	assert.ok(out.questionText.includes("![[plot.png]]"));
});

test("question calibration links a repeated source title only once", () => {
	const topic = makeTopic({ path: "CS/Version control.md", title: "Version control" });
	const structure = makeStructure({
		title: topic.title,
		headings: [{ heading: "Merge commits", level: 2 }],
		sections: [
			{
				heading: "Merge commits",
				level: 2,
				content: "Merges create a directed acyclic graph of commits.",
				wordCount: 8,
			},
		],
	});
	const [question] = calibrateQuestionsForPractice(
		[
			makeQuestion({
				questionText:
					"In Version control, the Version control history graph is a DAG. Why does merging cause that?",
				correctAnswer: "A merge commit has two parents.",
				options: [
					"A merge commit has two parents.",
					"Branches are always linear.",
					"Commits are stored unordered.",
					"Tags introduce cycles.",
				],
				sourceTopics: [topic.title],
				sourceSubtopics: ["Merge commits"],
				difficulty: "medium",
			}),
		],
		[{ note: topic, content: structure.cleanedText, history: "", structure }],
		[topic]
	);

	assert.ok(question);
	const links = question.questionText.match(/\[\[CS\/Version control\|Version control\]\]/g) ?? [];
	assert.equal(links.length, 1);
	// The second mention stays plain text.
	assert.ok(question.questionText.includes("the Version control history graph"));
});

test("FSRS retrievability is ~target at one stability and decays with time", () => {
	assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 0.02);
	assert.ok(retrievability(10, 0) > 0.99);
	assert.ok(retrievability(10, 30) < retrievability(10, 10));
	assert.equal(retrievability(0, 5), 0);
});

test("FSRS interval grows with stability and shrinks as target retention rises", () => {
	assert.ok(Math.abs(intervalForRetention(10) - 10) < 0.02);
	assert.ok(intervalForRetention(20) > intervalForRetention(10));
	assert.ok(intervalForRetention(10, 0.95) < intervalForRetention(10, 0.85));
});

test("FSRS stability compounds across successful reviews", () => {
	const first = nextStabilityDays(0, 0, 70, 1, 0.8, 0);
	const second = nextStabilityDays(first, intervalForRetention(first), 70, 1, 0.8, 0);
	const third = nextStabilityDays(second, intervalForRetention(second), 70, 1, 0.8, 0);
	assert.ok(second > first);
	assert.ok(third > second);
});

test("FSRS lapse pulls a mature note back within a few days", () => {
	const lapsed = nextStabilityDays(40, 60, 70, 0.2, 0.3, 0);
	assert.ok(lapsed >= 0.5 && lapsed <= 3);
	assert.ok(intervalForRetention(lapsed) <= 3);
});

test("FSRS grows stability faster for higher-skill (easier) notes", () => {
	const easy = nextStabilityDays(10, 10, 90, 1, 0.8, 0);
	const hard = nextStabilityDays(10, 10, 30, 1, 0.8, 0);
	assert.ok(easy > hard);
});

test("editing a practiced note halves its stability and makes it due", () => {
	const practicedAt = Date.UTC(2026, 5, 20, 12);
	const editedAt = Date.UTC(2026, 5, 25, 12);
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic({ updatedAt: editedAt });
	const memory = normalizePracticeMemory({
		version: 1,
		notes: {
			[topic.path]: makeNoteState(topic, {
				updatedAt: practicedAt - 1,
				lastPracticedAt: practicedAt,
				dueAt: now + 30 * 24 * 60 * 60 * 1000,
				attempts: 4,
				correct: 4,
				stabilityDays: 20,
			}),
		},
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: 0,
		},
		questionFeedback: [],
	} as unknown as PracticeMemory);

	// No results: only the reconcile against the edited topic runs.
	const next = updatePracticeMemoryAfterSession(memory, [topic], [], [], now);
	const state = next.notes[topic.path];
	assert.ok(state);
	assert.equal(state.stabilityDays, 10);
	assert.ok(state.dueAt <= now);

	// Reconciling again without a new edit must not halve stability again.
	const again = updatePracticeMemoryAfterSession(next, [topic], [], [], now + 1000);
	assert.equal(again.notes[topic.path]?.stabilityDays, 10);
});

test("session results record per-subtopic stability that compounds", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic({ skill: 70 });
	const delta: SkillDelta = {
		path: topic.path,
		title: topic.title,
		before: topic.skill,
		after: topic.skill,
	};
	const question = makeQuestion({
		sourceTopics: [topic.title],
		sourceSubtopics: ["pivot detection"],
	});

	const first = updatePracticeMemoryAfterSession(
		undefined, [topic], [makeResult(question)], [delta], now
	);
	const firstSub = first.notes[topic.path]?.practicedSubtopics["pivot detection"];
	assert.ok(firstSub);
	assert.ok((firstSub.stabilityDays ?? 0) > 0);

	const later = now + 3 * 24 * 60 * 60 * 1000;
	const second = updatePracticeMemoryAfterSession(
		first, [topic], [makeResult(question)], [delta], later
	);
	const secondSub = second.notes[topic.path]?.practicedSubtopics["pivot detection"];
	assert.ok(secondSub);
	assert.ok((secondSub.stabilityDays ?? 0) > (firstSub.stabilityDays ?? 0));
	assert.equal(secondSub.attempts, 2);
});

test("a fading subtopic pulls its note into daily selection", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const twentyDaysAgo = now - 20 * 24 * 60 * 60 * 1000;
	const base = {
		skill: 80,
		attempts: 4,
		correct: 4,
		lastPracticedAt: twentyDaysAgo,
		dueAt: now + 10 * 24 * 60 * 60 * 1000,
		stabilityDays: 40,
		lastSessionAccuracy: 1,
		lastSessionFluency: 1,
	};
	const fading = makeTopic({ path: "a/fading.md", title: "Fading note", skill: 80 });
	const solid = makeTopic({ path: "b/solid.md", title: "Solid note", skill: 80 });
	const memory = normalizePracticeMemory({
		version: 1,
		notes: {
			[fading.path]: makeNoteState(fading, {
				...base,
				practicedSubtopics: {
					"edge cases": {
						lastPracticedAt: twentyDaysAgo,
						attempts: 3,
						correct: 2,
						stabilityDays: 2,
					},
				},
			}),
			[solid.path]: makeNoteState(solid, { ...base }),
		},
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: 0,
		},
		questionFeedback: [],
	} as unknown as PracticeMemory);

	const selected = selectDailyTopics([fading, solid], memory, 1, now);
	assert.equal(selected.length, 1);
	assert.equal(selected[0]?.path, fading.path);
	assert.match(selected[0]?.scheduleReason ?? "", /fading subtopic: edge cases/);
});

test("flow sequencing interleaves topics instead of blocking them", () => {
	const questions = [
		...["a1", "a2", "a3"].map((id) =>
			makeQuestion({ id, questionText: `Alpha ${id}`, sourceTopics: ["Alpha"], difficulty: "medium" })
		),
		...["b1", "b2", "b3"].map((id) =>
			makeQuestion({ id, questionText: `Beta ${id}`, sourceTopics: ["Beta"], difficulty: "medium" })
		),
	];
	const sequenced = prepareGeneratedQuestionsForSession(questions, {
		questionCount: 6,
		topics: [
			makeTopic({ path: "a.md", title: "Alpha" }),
			makeTopic({ path: "b.md", title: "Beta" }),
		],
		challengeMode: "steady",
	});
	const topicsInOrder = sequenced.map((question) => question.sourceTopics[0]);
	let alternations = 0;
	for (let i = 1; i < topicsInOrder.length; i++) {
		if (topicsInOrder[i] !== topicsInOrder[i - 1]) alternations++;
	}
	assert.equal(sequenced.length, 6);
	assert.equal(alternations, 5, `expected full alternation, got ${topicsInOrder.join(",")}`);
});

test("new-note throttle holds at three even for large topic limits", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const reviewed = makeTopic({ path: "old/reviewed.md", title: "Reviewed note" });
	const untouched = Array.from({ length: 10 }, (_, index) =>
		makeTopic({ path: `new/note-${index}.md`, title: `New note ${index}` })
	);
	const memory = normalizePracticeMemory({
		version: 1,
		notes: {
			[reviewed.path]: makeNoteState(reviewed, {
				attempts: 4,
				correct: 3,
				lastPracticedAt: now - 8 * DAY_MS,
				dueAt: now - DAY_MS,
			}),
		},
		index: {},
		daily: {
			lastReminderDate: "",
			lastReminderAttemptAt: 0,
			lastPracticeDate: "",
			streak: 0,
			lastScanAt: now,
		},
		questionFeedback: [],
	} as unknown as PracticeMemory);

	const selected = selectDailyTopics([reviewed, ...untouched], memory, 12, now);
	const untouchedCount = selected.filter((topic) => topic.path.startsWith("new/")).length;
	// Old behavior allowed ceil(12/2) = 6 new notes; the throttle holds at 3.
	assert.equal(untouchedCount, 3);
	assert.ok(selected.some((topic) => topic.path === reviewed.path));
});

test("target retention setting stretches or tightens review intervals", () => {
	const now = Date.UTC(2026, 5, 26, 12);
	const topic = makeTopic({ skill: 80 });
	const delta: SkillDelta = {
		path: topic.path,
		title: topic.title,
		before: topic.skill,
		after: topic.skill,
	};
	const results = [
		makeResult(
			makeQuestion({ sourceTopics: [topic.title], difficulty: "medium" }),
			{ isCorrect: true, timeTakenMs: 30_000 }
		),
	];

	const relaxed = updatePracticeMemoryAfterSession(
		undefined, [topic], results, [delta], now, { targetRetention: 0.8 }
	);
	const intensive = updatePracticeMemoryAfterSession(
		undefined, [topic], results, [delta], now, { targetRetention: 0.95 }
	);
	const relaxedDue = relaxed.notes[topic.path]?.dueAt ?? 0;
	const intensiveDue = intensive.notes[topic.path]?.dueAt ?? 0;
	assert.ok(relaxedDue > intensiveDue);
	// Same stability either way — only the due date moves.
	assert.equal(
		relaxed.notes[topic.path]?.stabilityDays,
		intensive.notes[topic.path]?.stabilityDays
	);
});

async function runAllTests(): Promise<void> {
	let failed = 0;
	for (const { name, run } of tests) {
		try {
			await run();
			console.log(`ok - ${name}`);
		} catch (error) {
			failed += 1;
			console.error(`not ok - ${name}`);
			console.error(error);
		}
	}

	if (failed > 0) {
		throw new Error(`${failed} adaptive core test${failed === 1 ? "" : "s"} failed`);
	}

	console.log(`${tests.length} adaptive core tests passed`);
}

const testRunGlobal = globalThis as typeof globalThis & {
	__adaptivePracticeTests?: Promise<void>;
};
testRunGlobal.__adaptivePracticeTests = runAllTests();
