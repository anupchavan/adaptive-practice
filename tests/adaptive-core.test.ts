import assert from "node:assert/strict";
import { buildPrompt } from "../src/llm/prompt";
import { parseQuestions } from "../src/llm/parse";
import {
	extractProviderErrorDetail,
	formatProviderError,
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
} from "../src/practice/scheduler";
import { hasPracticedToday } from "../src/practice/daily-status";
import {
	reconcileGeneratedQuestions,
	reconcileSourceTopics,
	resolveQuestionTargetTopics,
} from "../src/practice/source-map";
import {
	buildChallengeTopUpPrompt,
	buildQuestionTopUpPrompt,
	mergeQuestionBatches,
} from "../src/practice/question-quality";
import {
	calibrateQuestionsForPractice,
} from "../src/practice/question-calibration";
import {
	selectFlowBalancedQuestions,
	prepareGeneratedQuestionsForSession,
	shouldRequestChallengeTopUp,
} from "../src/practice/flow-calibration";
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
	QuizResult,
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
	assert.deepEqual(question.options, [
		"left half is always sorted",
		"one half is always sorted",
		"neither side can be sorted",
		"both halves are always sorted",
	]);
	assert.equal(question.correctAnswer, "one half is always sorted");
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
	assert.deepEqual(questions[0]?.options, [
		"left half",
		"right half",
		"both halves",
		"neither half",
	]);
	assert.equal(questions[0]?.correctAnswer, "right half");
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
				sourceSubtopics: ["Binary search rotation", "Pivot boundary"],
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
	const now = Date.UTC(2026, 5, 27, 12);
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
		],
		8
	);

	assert.match(prompt.textPrompt, /two or more substantial reasoning moves/);
	assert.match(prompt.textPrompt, /direct update recall/);
	assert.match(prompt.textPrompt, /direct complexity recall/);
	assert.match(prompt.textPrompt, /one-branch checks/);
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

	const skippedMemory = updatePracticeMemoryAfterSession(
		undefined,
		[topic],
		skippedResults,
		[],
		now
	);
	const engagedMemory = updatePracticeMemoryAfterSession(
		undefined,
		[topic],
		engagedResults,
		[],
		now
	);

	assert.equal(hasPracticedToday(skippedMemory, new Date(now)), false);
	assert.equal(skippedMemory.daily.streak, 0);
	assert.equal(hasPracticedToday(engagedMemory, new Date(now)), true);
	assert.equal(engagedMemory.daily.streak, 1);
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
		now
	);

	assert.equal(updated.daily.lastPracticeDate, "2026-06-26");
	assert.equal(updated.daily.streak, 5);
});

test("planDailySession shortens fragile daily review into a warm-up", () => {
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
	assert.equal(plan.questionCount, 6);
	assert.match(plan.reason, /low skill/);
	assert.match(plan.reason, /recent misses/);
	assert.match(plan.reason, /slow recall/);
});

test("planDailySession stretches fluent daily review without exceeding bounds", () => {
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
	assert.equal(plan.questionCount, 20);
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
	assert.equal(plan.questionCount, 9);
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
	assert.match(prompt.textPrompt, /mostly easy\/medium questions/);
	assert.match(prompt.textPrompt, /diagnostic questions/);
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
	assert.match(prompt.textPrompt, /mostly medium\/hard questions/);
	assert.match(prompt.textPrompt, /edge cases/);
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
