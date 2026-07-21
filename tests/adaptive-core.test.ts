import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
import { folderLabel, stringifyGroupValue } from "../src/ui/topic-groups";
import { checkRules, normalizeFilterRules } from "../src/filters/matcher";
import { hasBlockMarkdown } from "../src/ui/markdown-detection";
import { normalizeMarkdownForRender } from "../src/ui/markdown-normalize";
import {
	AdaptivePracticeSettings,
	PracticeMemory,
	NoteIndexEntry,
	NoteStructure,
	NoteMediaReference,
	DEFAULT_SETTINGS,
	FilterGroup,
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
	// Older untouched notes are day-shuffled, so assert membership + limit,
	// not a fixed order — and that the same day yields the same plan.
	const titles = new Set(topics.map((topic) => topic.title));
	assert.ok(selected.every((topic) => titles.has(topic.title)));
	assert.equal(new Set(selected.map((t) => t.title)).size, 6);
	assert.ok(selected.every((topic) => /new/.test(topic.scheduleReason ?? "")));
	assert.deepEqual(
		selectDailyTopics(topics, undefined, 6, now).map((t) => t.title),
		selected.map((t) => t.title)
	);
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

function makeLinuxSessionConfig(topic: TopicNote): SessionConfig {
	return {
		topics: [topic],
		questionCount: 8,
		challengeMode: "steady",
		challengeReason: "high-skill Linux regression",
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
