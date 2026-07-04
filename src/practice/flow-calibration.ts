import { DailyChallengeMode, Difficulty, Question, SessionConfig, TopicNote } from "../types";
import { isDeepHardQuestion } from "./difficulty-quality";

export function shouldRequestChallengeTopUp(
	questions: Question[],
	topics: TopicNote[],
	mode: DailyChallengeMode = "steady"
): boolean {
	if (questions.length < 4) return false;
	if (mode === "warmup" && topics.every((topic) => topic.skill <= 80)) return false;
	if (highSkillTopicShortfallMessage(questions, topics, mode, questions.length)) return true;
	const counts = countDifficulties(questions);
	const skill = averageSkill(topics);
	const desired = desiredDifficultyCounts(
		questions.length,
		skill,
		mode
	);
	const mediumPlus = counts.medium + counts.hard;
	const desiredMediumPlus = desired.medium + desired.hard;
	const mediumPlusFloor = Math.min(questions.length, Math.max(2, desiredMediumPlus - 1));
	const minimumHard = minimumRequiredHard(desired, skill, mode);
	const highSkill = skill > 80;
	return (
		(highSkill && counts.easy > desired.easy) ||
		counts.easy > desired.easy + 1 ||
		mediumPlus < mediumPlusFloor ||
		((mode === "stretch" || highSkill) &&
			counts.hard < minimumHard)
	);
}

export function isStrictChallengeSession(
	topics: TopicNote[],
	_mode: DailyChallengeMode = "steady"
): boolean {
	return (
		averageSkill(topics) > 80 ||
		topics.some((topic) => topic.skill > 80)
	);
}

export function challengeShortfallMessage(
	questions: Question[],
	topics: TopicNote[],
	mode: DailyChallengeMode = "steady",
	desiredCount = questions.length
): string {
	if (!isStrictChallengeSession(topics, mode)) return "";

	const skill = averageSkill(topics);
	const desired = desiredDifficultyCounts(desiredCount, skill, mode);
	const counts = countDifficulties(questions);
	const mediumPlus = counts.medium + counts.hard;
	const desiredMediumPlus = desired.medium + desired.hard;
	const mediumPlusFloor = Math.min(desiredCount, Math.max(2, desiredMediumPlus - 1));
	const tooFew = questions.length < desiredCount;
	if (tooFew) {
		return [
			`Generated only ${questions.length} of ${desiredCount} questions for current skill (${Math.round(skill)}/100).`,
			`Expected about ${desired.easy} easy, ${desired.medium} medium, ${desired.hard} hard; got ${counts.easy} easy, ${counts.medium} medium, ${counts.hard} hard.`,
			"Try again or switch to a stronger model for this note.",
		].join(" ");
	}

	const topicMessage = highSkillTopicShortfallMessage(questions, topics, mode, desiredCount);
	if (topicMessage) return topicMessage;

	const tooEasy =
		counts.easy > desired.easy ||
		mediumPlus < mediumPlusFloor ||
		counts.hard < minimumRequiredHard(desired, skill, mode);
	if (!tooEasy) return "";

	return [
		`Generated questions are still too easy for current skill (${Math.round(skill)}/100).`,
		`Expected about ${desired.easy} easy, ${desired.medium} medium, ${desired.hard} hard; got ${counts.easy} easy, ${counts.medium} medium, ${counts.hard} hard.`,
		"Try again or switch to a stronger model for this note.",
	].join(" ");
}

function highSkillTopicShortfallMessage(
	questions: Question[],
	topics: TopicNote[],
	mode: DailyChallengeMode,
	desiredCount: number
): string {
	for (const topic of topics.filter((candidate) => candidate.skill > 80)) {
		const minimumTargeted = minimumHighSkillTopicQuestions(
			topics,
			desiredCount
		);
		if (minimumTargeted === 0) continue;

		const targeted = questions.filter((question) =>
			questionTargetsTopic(question, topic)
		);
		if (targeted.length < minimumTargeted) {
			if (targeted.length === 0) {
				return [
					`Generated questions did not cover high-skill topic "${topic.title}" (skill ${Math.round(topic.skill)}/100).`,
					"Include at least one medium/hard question for each selected high-skill topic, or reduce the topic count.",
				].join(" ");
			}
			return [
				`Generated questions barely covered high-skill topic "${topic.title}" (skill ${Math.round(topic.skill)}/100).`,
				`Expected at least ${minimumTargeted} questions for that topic in this ${desiredCount}-question session; got ${targeted.length}.`,
				"Include more medium/hard questions for the high-skill topic, or reduce the topic count.",
			].join(" ");
		}
		const counts = countDifficulties(targeted, topic);
		const desired = desiredDifficultyCounts(
			Math.max(targeted.length, minimumTargeted),
			topic.skill,
			mode
		);
		const tooEasy = counts.easy > 0;
		const minimumHard = minimumRequiredHard(desired, topic.skill, mode);
		const tooFewHard = counts.hard < minimumHard;
		if (tooEasy || tooFewHard) {
			return [
				`Generated questions for high-skill topic "${topic.title}" are still too easy (skill ${Math.round(topic.skill)}/100).`,
				`Expected about ${desired.easy} easy, ${desired.medium} medium, ${desired.hard} hard for that topic; got ${counts.easy} easy, ${counts.medium} medium, ${counts.hard} hard.`,
				"Try again or switch to a stronger model for this note.",
			].join(" ");
		}
		const minimumSubtopics = minimumHighSkillSubtopics(targeted.length);
		const subtopicCount = countPrimarySubtopics(targeted, topic);
		if (subtopicCount < minimumSubtopics) {
			return [
				`Generated questions for high-skill topic "${topic.title}" are too repetitive (skill ${Math.round(topic.skill)}/100).`,
				`Expected questions to span at least ${minimumSubtopics} source subtopics; got ${subtopicCount}.`,
				"Spread hard questions across different concepts, traps, or sections from that note.",
			].join(" ");
		}
		const minimumSetups = minimumHighSkillSetups(targeted.length, topic);
		const setupCount = clusterBySetup(targeted).length;
		if (minimumSetups > 0 && setupCount < minimumSetups) {
			return [
				`Generated questions for high-skill topic "${topic.title}" are too narrow (skill ${Math.round(topic.skill)}/100).`,
				`Expected questions to span at least ${minimumSetups} distinct question setups; got ${setupCount}.`,
				"Vary the scenario, the reasoning target, and the failure mode instead of re-skinning one setup.",
			].join(" ");
		}
	}
	return "";
}

function minimumHighSkillTopicQuestions(
	topics: TopicNote[],
	desiredCount: number
): number {
	if (desiredCount <= 0) return 0;
	const highSkillTopicCount = topics.filter((topic) => topic.skill > 80).length;
	if (highSkillTopicCount === 0) return 0;
	if (highSkillTopicCount > desiredCount) return 0;
	if (topics.length <= 1) return desiredCount;
	const fairShare = Math.floor(desiredCount / topics.length);
	return Math.max(1, Math.min(2, fairShare));
}

function minimumHighSkillSubtopics(targetedCount: number): number {
	if (targetedCount < 4) return 1;
	return Math.min(4, Math.max(2, Math.floor(targetedCount / 4) + 1));
}

function minimumHighSkillSetups(
	targetedCount: number,
	topic: TopicNote
): number {
	if (!requiresSetupDiversity(topic)) return 0;
	if (targetedCount < 4) return 1;
	return 2;
}

export function selectFlowBalancedQuestions(
	existing: Question[],
	candidates: Question[],
	desiredCount: number,
	topics: TopicNote[],
	mode: DailyChallengeMode = "steady"
): Question[] {
	const all = preferChallengeReadyQuestions(
		uniqueByStem([...existing, ...candidates]),
		desiredCount,
		topics,
		mode
	);
	if (all.length <= desiredCount) return sequenceForFlow(all);

	const desired = desiredDifficultyCounts(desiredCount, averageSkill(topics), mode);
	const buckets: Record<Difficulty, Question[]> = {
		easy: [],
		medium: [],
		hard: [],
	};
	for (const question of all) {
		buckets[question.difficulty].push(question);
	}

	const selected: Question[] = [];
	take(selected, buckets.hard, desired.hard);
	take(selected, buckets.medium, desired.medium);
	take(selected, buckets.easy, desired.easy);

	const leftovers = uniqueByStem([
		...buckets.hard,
		...buckets.medium,
		...buckets.easy,
	]).filter((question) => !selected.includes(question));
	take(selected, leftovers, desiredCount - selected.length);

	return sequenceForFlow(
		ensureHighSkillTopicCoverage(
			selected.slice(0, desiredCount),
			all,
			desiredCount,
			topics,
			mode
		)
	);
}

export function prepareGeneratedQuestionsForSession(
	questions: Question[],
	config: Pick<SessionConfig, "questionCount" | "topics" | "challengeMode">
): Question[] {
	return selectFlowBalancedQuestions(
		questions,
		[],
		config.questionCount,
		config.topics,
		config.challengeMode
	);
}

export function desiredDifficultyCounts(
	count: number,
	averageSkillValue: number,
	mode: DailyChallengeMode = "steady"
): Record<Difficulty, number> {
	const skill = Number.isFinite(averageSkillValue) ? averageSkillValue : 50;
	let ratios: Record<Difficulty, number>;
	if (mode === "warmup" && skill >= 90) {
		ratios = { easy: 0, medium: 0.35, hard: 0.65 };
	} else if (mode === "warmup" && skill >= 85) {
		ratios = { easy: 0, medium: 0.45, hard: 0.55 };
	} else if (mode === "warmup" && skill > 80) {
		ratios = { easy: 0, medium: 0.5, hard: 0.5 };
	} else if (mode === "warmup") {
		ratios = { easy: 0.55, medium: 0.4, hard: 0.05 };
	} else if (mode === "stretch" && skill >= 90) {
		ratios = { easy: 0, medium: 0.1, hard: 0.9 };
	} else if (mode === "stretch" && skill >= 85) {
		ratios = { easy: 0, medium: 0.15, hard: 0.85 };
	} else if (mode === "stretch" && skill > 80) {
		ratios = { easy: 0, medium: 0.2, hard: 0.8 };
	} else if (mode === "stretch") {
		ratios = { easy: 0.05, medium: 0.4, hard: 0.55 };
	} else if (skill <= 30) {
		ratios = { easy: 0.6, medium: 0.3, hard: 0.1 };
	} else if (skill <= 60) {
		ratios = { easy: 0.3, medium: 0.45, hard: 0.25 };
	} else if (skill <= 80) {
		ratios = { easy: 0.1, medium: 0.4, hard: 0.5 };
	} else if (skill >= 90) {
		ratios = { easy: 0, medium: 0.1, hard: 0.9 };
	} else if (skill >= 85) {
		ratios = { easy: 0, medium: 0.15, hard: 0.85 };
	} else {
		ratios = { easy: 0, medium: 0.25, hard: 0.75 };
	}

	const easy = Math.round(count * ratios.easy);
	const hard = Math.round(count * ratios.hard);
	const medium = Math.max(0, count - easy - hard);
	return { easy, medium, hard };
}

function minimumRequiredHard(
	desired: Record<Difficulty, number>,
	skill: number,
	mode: DailyChallengeMode
): number {
	if (desired.hard <= 0) return 0;
	if (mode === "warmup" && skill <= 80) return 0;
	if (skill >= 90) return desired.hard;
	return Math.max(1, desired.hard - 1);
}

function countDifficulties(
	questions: Question[],
	topic?: TopicNote
): Record<Difficulty, number> {
	return {
		easy: questions.filter((question) =>
			effectiveDifficultyForTopic(question, topic) === "easy"
		).length,
		medium: questions.filter((question) =>
			effectiveDifficultyForTopic(question, topic) === "medium"
		).length,
		hard: questions.filter((question) =>
			effectiveDifficultyForTopic(question, topic) === "hard"
		).length,
	};
}

function effectiveDifficultyForTopic(
	question: Question,
	topic?: TopicNote
): Difficulty {
	if (
		topic &&
		requiresVerifiedHard(topic) &&
		question.difficulty === "hard" &&
		!isDeepHardQuestion(question)
	) {
		return "medium";
	}
	return question.difficulty;
}

function sequenceForFlow(questions: Question[]): Question[] {
	const buckets: Record<Difficulty, Question[]> = {
		easy: [],
		medium: [],
		hard: [],
	};
	for (const question of questions) {
		buckets[question.difficulty].push(question);
	}

	const out: Question[] = [];
	takeFirstAvailable(out, buckets, ["easy", "medium", "hard"], null);

	while (hasRemaining(buckets)) {
		const lastQuestion = out[out.length - 1];
		const last = lastQuestion?.difficulty;
		const preferences = nextDifficultyPreferences(last);
		const recent = out.slice(-2).map((question) => question.difficulty);
		const avoid =
			recent.length === 2 && recent[0] === recent[1]
				? recent[0]
				: null;
		const preferred = avoid
			? preferences.filter((difficulty) => difficulty !== avoid)
			: preferences;
		// Interleave topics: prefer a question from a different note than the
		// previous one (contextual-interference effect). Topic alternation
		// outranks the difficulty-streak avoidance; both fall away only when a
		// single topic remains.
		const avoidTopic = lastQuestion ? primaryTopicKey(lastQuestion) : null;
		if (
			!takeFirstAvailable(out, buckets, preferred, avoidTopic) &&
			!takeFirstAvailable(out, buckets, preferences, avoidTopic) &&
			!takeFirstAvailable(out, buckets, preferred, null)
		) {
			takeFirstAvailable(out, buckets, preferences, null);
		}
	}

	return out;
}

function primaryTopicKey(question: Question): string {
	return normalize(question.sourceTopics[0] ?? "");
}

function nextDifficultyPreferences(last: Difficulty | undefined): Difficulty[] {
	if (last === "easy") return ["medium", "hard", "easy"];
	if (last === "medium") return ["hard", "medium", "easy"];
	if (last === "hard") return ["medium", "easy", "hard"];
	return ["easy", "medium", "hard"];
}

function takeFirstAvailable(
	out: Question[],
	buckets: Record<Difficulty, Question[]>,
	preferences: Difficulty[],
	avoidTopic: string | null
): boolean {
	for (const difficulty of preferences) {
		const bucket = buckets[difficulty];
		if (bucket.length === 0) continue;
		let index = 0;
		if (avoidTopic) {
			const alternative = bucket.findIndex(
				(question) => primaryTopicKey(question) !== avoidTopic
			);
			if (alternative < 0) continue;
			index = alternative;
		}
		out.push(bucket.splice(index, 1)[0]!);
		return true;
	}
	return false;
}

function hasRemaining(buckets: Record<Difficulty, Question[]>): boolean {
	return buckets.easy.length + buckets.medium.length + buckets.hard.length > 0;
}

function uniqueByStem(questions: Question[]): Question[] {
	const out: Question[] = [];
	const seen = new Set<string>();
	for (const question of questions) {
		const key = normalize(`${question.questionText} ${question.correctAnswer}`);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(question);
	}
	return out;
}

function preferChallengeReadyQuestions(
	questions: Question[],
	desiredCount: number,
	topics: TopicNote[],
	mode: DailyChallengeMode
): Question[] {
	if (topics.every((topic) => topic.skill <= 80)) {
		return questions;
	}

	const tooEasyForHighSkill = questions.filter((question) =>
		question.difficulty === "easy" &&
		topics.some((topic) => topic.skill > 80 && questionTargetsTopic(question, topic))
	);
	const tooWeakForVerifiedHard = questions.filter((question) =>
		question.difficulty === "hard" &&
		topics.some((topic) =>
			questionTargetsTopic(question, topic) &&
			requiresVerifiedHard(topic) &&
			effectiveDifficultyForTopic(question, topic) !== "hard"
		)
	);
	if (tooEasyForHighSkill.length === 0 && tooWeakForVerifiedHard.length === 0) {
		return questions;
	}

	const challengeReady = questions.filter(
		(question) =>
			!tooEasyForHighSkill.includes(question) &&
			!tooWeakForVerifiedHard.includes(question)
	);
	if (challengeReady.length >= desiredCount) return challengeReady;
	return [...challengeReady, ...tooWeakForVerifiedHard, ...tooEasyForHighSkill];
}

function ensureHighSkillTopicCoverage(
	selected: Question[],
	all: Question[],
	desiredCount: number,
	topics: TopicNote[],
	mode: DailyChallengeMode
): Question[] {
	const highSkillTopics = topics.filter((topic) => topic.skill > 80);
	if (
		highSkillTopics.length === 0 ||
		highSkillTopics.length > desiredCount
	) {
		return selected;
	}

	const next = [...selected];
	for (const topic of highSkillTopics) {
		const minimumTargeted = minimumHighSkillTopicQuestions(topics, desiredCount);
		for (let attempt = 0; attempt < desiredCount; attempt++) {
			const targeted = next.filter((question) => questionTargetsTopic(question, topic));
			const counts = countDifficulties(targeted, topic);
			const desired = desiredDifficultyCounts(
				Math.max(1, targeted.length, minimumTargeted),
				topic.skill,
				mode
			);
			const minimumHard = minimumRequiredHard(desired, topic.skill, mode);
			if (
				targeted.length >= minimumTargeted &&
				counts.easy === 0 &&
				counts.hard >= minimumHard
			) {
				break;
			}
			const candidate = bestCoverageCandidate(
				all,
				next,
				topic,
				counts.hard < minimumHard
			);
			if (!candidate) break;
			const replacementIndex =
				targeted.length < minimumTargeted
					? replacementIndexForAdditionalCoverage(next, highSkillTopics, topic)
					: replacementIndexForCoverage(next, highSkillTopics, topic);
			if (replacementIndex < 0) break;
			next[replacementIndex] = candidate;
		}
		ensureHighSkillSubtopicDiversity(next, all, topic);
		ensureHighSkillSetupDiversity(next, all, topic);
	}
	return next;
}

function ensureHighSkillSubtopicDiversity(
	selected: Question[],
	all: Question[],
	topic: TopicNote
): void {
	for (let attempt = 0; attempt < selected.length; attempt++) {
		const targeted = selected.filter((question) => questionTargetsTopic(question, topic));
		const minimumSubtopics = minimumHighSkillSubtopics(targeted.length);
		const currentSubtopics = primarySubtopicSet(targeted, topic);
		if (currentSubtopics.size >= minimumSubtopics) return;

		const candidate = all
			.filter((question) =>
				!selected.includes(question) &&
				effectiveDifficultyForTopic(question, topic) !== "easy" &&
				questionTargetsTopic(question, topic)
			)
			.filter((question) => {
				const subtopic = primarySubtopic(question, topic);
				return subtopic && !currentSubtopics.has(subtopic);
			})
			.sort((a, b) =>
				difficultyRank(effectiveDifficultyForTopic(b, topic)) -
				difficultyRank(effectiveDifficultyForTopic(a, topic))
			)[0];
		if (!candidate) return;

		const replacementIndex = replacementIndexForRepeatedSubtopic(selected, topic);
		if (replacementIndex < 0) return;
		selected[replacementIndex] = candidate;
	}
}

function ensureHighSkillSetupDiversity(
	selected: Question[],
	all: Question[],
	topic: TopicNote
): void {
	if (!requiresSetupDiversity(topic)) return;

	for (let attempt = 0; attempt < selected.length; attempt++) {
		const targeted = selected.filter((question) => questionTargetsTopic(question, topic));
		const minimumSetups = minimumHighSkillSetups(targeted.length, topic);
		if (minimumSetups <= 1) return;
		const clusters = clusterBySetup(targeted);
		if (clusters.length >= minimumSetups) return;

		const candidate = all
			.filter((question) =>
				!selected.includes(question) &&
				effectiveDifficultyForTopic(question, topic) !== "easy" &&
				questionTargetsTopic(question, topic)
			)
			.filter((question) => {
				const signature = setupSignature(question);
				return clusters.every(
					(cluster) => setupOverlap(cluster.signature, signature) < SETUP_SIMILARITY_THRESHOLD
				);
			})
			.sort((a, b) =>
				difficultyRank(effectiveDifficultyForTopic(b, topic)) -
				difficultyRank(effectiveDifficultyForTopic(a, topic))
			)[0];
		if (!candidate) return;

		const replacementIndex = replacementIndexForRepeatedSetup(selected, topic);
		if (replacementIndex < 0) return;
		selected[replacementIndex] = candidate;
	}
}

function bestCoverageCandidate(
	all: Question[],
	selected: Question[],
	topic: TopicNote,
	requireHard = false
): Question | null {
	return all
		.filter((question) =>
			!selected.includes(question) &&
			effectiveDifficultyForTopic(question, topic) !== "easy" &&
			(!requireHard || effectiveDifficultyForTopic(question, topic) === "hard") &&
			questionTargetsTopic(question, topic)
		)
		.sort((a, b) =>
			difficultyRank(effectiveDifficultyForTopic(b, topic)) -
			difficultyRank(effectiveDifficultyForTopic(a, topic))
		)[0] ?? null;
}

function replacementIndexForCoverage(
	selected: Question[],
	highSkillTopics: TopicNote[],
	preferredTopic: TopicNote
): number {
	const weakTargetIndex = selected.findIndex((question) =>
		questionTargetsTopic(question, preferredTopic) &&
		effectiveDifficultyForTopic(question, preferredTopic) !== "hard"
	);
	if (weakTargetIndex >= 0) return weakTargetIndex;

	for (const difficulty of ["easy", "medium", "hard"] as Difficulty[]) {
		const index = selected.findIndex((question) =>
			question.difficulty === difficulty &&
			!highSkillTopics.some((topic) => questionTargetsTopic(question, topic))
		);
		if (index >= 0) return index;
	}
	return -1;
}

function replacementIndexForAdditionalCoverage(
	selected: Question[],
	highSkillTopics: TopicNote[],
	preferredTopic: TopicNote
): number {
	for (const difficulty of ["easy", "medium", "hard"] as Difficulty[]) {
		const index = selected.findIndex((question) =>
			question.difficulty === difficulty &&
			!questionTargetsTopic(question, preferredTopic) &&
			!highSkillTopics.some((topic) => questionTargetsTopic(question, topic))
		);
		if (index >= 0) return index;
	}

	for (const difficulty of ["easy", "medium", "hard"] as Difficulty[]) {
		const index = selected.findIndex((question) =>
			question.difficulty === difficulty &&
			!questionTargetsTopic(question, preferredTopic)
		);
		if (index >= 0) return index;
	}

	return -1;
}

function replacementIndexForRepeatedSubtopic(
	selected: Question[],
	topic: TopicNote
): number {
	const counts = new Map<string, number>();
	for (const question of selected) {
		if (!questionTargetsTopic(question, topic)) continue;
		const subtopic = primarySubtopic(question, topic);
		if (!subtopic) continue;
		counts.set(subtopic, (counts.get(subtopic) ?? 0) + 1);
	}

	for (const difficulty of ["medium", "hard"] as Difficulty[]) {
		const index = selected.findIndex((question) => {
			if (question.difficulty !== difficulty || !questionTargetsTopic(question, topic)) {
				return false;
			}
			const subtopic = primarySubtopic(question, topic);
			return !!subtopic && (counts.get(subtopic) ?? 0) > 1;
		});
		if (index >= 0) return index;
	}
	return -1;
}

function replacementIndexForRepeatedSetup(
	selected: Question[],
	topic: TopicNote
): number {
	const targeted = selected.filter((question) => questionTargetsTopic(question, topic));
	const repeated = new Set(
		clusterBySetup(targeted)
			.filter((cluster) => cluster.members.length > 1)
			.flatMap((cluster) => cluster.members)
	);
	for (const difficulty of ["medium", "hard"] as Difficulty[]) {
		const index = selected.findIndex((question) =>
			question.difficulty === difficulty &&
			questionTargetsTopic(question, topic) &&
			repeated.has(question)
		);
		if (index >= 0) return index;
	}
	return -1;
}

function difficultyRank(difficulty: Difficulty): number {
	if (difficulty === "hard") return 3;
	if (difficulty === "medium") return 2;
	return 1;
}

function take<T>(out: T[], source: T[], count: number): void {
	while (count > 0 && source.length > 0) {
		const item = source.shift();
		if (item) out.push(item);
		count--;
	}
}

function averageSkill(topics: TopicNote[]): number {
	if (topics.length === 0) return 50;
	return topics.reduce((sum, topic) => sum + topic.skill, 0) / topics.length;
}

function questionTargetsTopic(question: Question, topic: TopicNote): boolean {
	const labels = topicLabels(topic);
	if (labels.length === 0) return false;
	const sources = (question.sourceTopics ?? [])
		.map(normalizeTopicLabel)
		.filter(Boolean);
	if (sources.length === 0) return false;
	return sources.some((source) =>
		labels.some((label) =>
			source === label ||
			source.endsWith(` ${label}`) ||
			label.endsWith(` ${source}`)
		)
	);
}

/**
 * At skill 90+, a "hard" label must survive independent verification — the
 * question has to demonstrate real stacked reasoning, whatever the domain.
 */
function requiresVerifiedHard(topic: TopicNote): boolean {
	return topic.skill >= 90;
}

function requiresSetupDiversity(topic: TopicNote): boolean {
	return topic.skill > 80;
}

function countPrimarySubtopics(questions: Question[], topic: TopicNote): number {
	return primarySubtopicSet(questions, topic).size;
}

function primarySubtopicSet(questions: Question[], topic: TopicNote): Set<string> {
	const out = new Set<string>();
	for (const question of questions) {
		const subtopic = primarySubtopic(question, topic);
		if (subtopic) out.add(subtopic);
	}
	return out;
}

/**
 * Near-duplicate detection: two questions share a "setup" when their content
 * tokens overlap heavily, regardless of what their subtopic labels claim.
 * Catches a batch that re-skins one scenario eight times — in any domain.
 */
const SETUP_SIMILARITY_THRESHOLD = 0.6;

interface SetupCluster {
	signature: Set<string>;
	members: Question[];
}

function clusterBySetup(questions: Question[]): SetupCluster[] {
	const clusters: SetupCluster[] = [];
	for (const question of questions) {
		const signature = setupSignature(question);
		const home = clusters.find(
			(cluster) => setupOverlap(cluster.signature, signature) >= SETUP_SIMILARITY_THRESHOLD
		);
		if (home) {
			home.members.push(question);
		} else {
			clusters.push({ signature, members: [question] });
		}
	}
	return clusters;
}

const SETUP_STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "what", "which", "when",
	"where", "why", "how", "does", "not", "are", "was", "were", "from",
	"into", "each", "case", "given", "explain", "after", "then", "your",
	"you", "one", "two", "three", "question", "questions", "correct",
	"answer", "option", "options", "following",
]);

function setupSignature(question: Question): Set<string> {
	const text = [
		question.questionText,
		question.correctAnswer,
		...(question.options ?? []),
	].join(" ");
	return new Set(
		normalize(text)
			.split(" ")
			.filter(
				(token) =>
					token.length >= 3 &&
					!/^\d+$/.test(token) &&
					!SETUP_STOPWORDS.has(token)
			)
	);
}

function setupOverlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 1;
	let intersection = 0;
	for (const token of a) {
		if (b.has(token)) intersection++;
	}
	const union = a.size + b.size - intersection;
	return union === 0 ? 1 : intersection / union;
}

function primarySubtopic(question: Question, topic: TopicNote): string | null {
	const labels = new Set(topicLabels(topic));
	for (const subtopic of question.sourceSubtopics ?? []) {
		const normalized = normalizeTopicLabel(subtopic);
		if (!normalized || labels.has(normalized) || isGenericSubtopicLabel(normalized)) {
			continue;
		}
		return normalized;
	}
	return null;
}

function isGenericSubtopicLabel(value: string): boolean {
	return /^(note|notes|topic|topics|chapter|section|sections|overview|problem|problems|intro|introduction|basics?|fundamentals?|examples?|summary)$/.test(value);
}

function topicLabels(topic: TopicNote): string[] {
	const withoutExtension = topic.path.replace(/\.[^.]+$/, "");
	const basename = withoutExtension.split("/").pop() ?? withoutExtension;
	return [
		topic.title,
		...(topic.aliases ?? []),
		topic.path,
		withoutExtension,
		basename,
	]
		.map(normalizeTopicLabel)
		.filter(Boolean);
}

function normalizeTopicLabel(value: string): string {
	return value
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[_/-]+/g, " ")
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
