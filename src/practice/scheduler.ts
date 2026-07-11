import {
	DEFAULT_PRACTICE_MEMORY,
	NoteHeading,
	NoteIndexEntry,
	NoteIndexMedia,
	NotePracticeState,
	PracticeMemory,
	QuestionFeedbackEntry,
	QuizResult,
	SkillDelta,
	DailySessionPlan,
	TopicNote,
} from "../types";
import { expectedTimeMs, resultFluency } from "./grader";
import { reconcileSourceTopics } from "./source-map";
import { compactQuizResults } from "./results";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REMINDER_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

interface TopicScore {
	topic: TopicNote;
	score: number;
	reason: string;
}

interface SessionTopicStats {
	attempts: number;
	correct: number;
	skipped: number;
	totalTimeMs: number;
	fluencySum: number;
	subtopics: Map<string, { attempts: number; correct: number }>;
}

interface PracticeMemoryUpdateOptions {
	countDailyCredit?: boolean;
	/** Desired recall probability when a note comes due (0.7–0.97). */
	targetRetention?: number;
}

export interface PracticeMeaningfulnessEvaluation {
	meaningful: boolean;
	reason:
		| "engaged"
		| "no-answers"
		| "too-few-attempts"
		| "too-fast-average"
		| "too-fast-total"
		| "too-fast-relative"
		| "no-demonstrated-recall";
	detail: string;
}

export function clonePracticeMemory(): PracticeMemory {
	return JSON.parse(JSON.stringify(DEFAULT_PRACTICE_MEMORY)) as PracticeMemory;
}

export function normalizePracticeMemory(input: PracticeMemory | undefined): PracticeMemory {
	const base = clonePracticeMemory();
	if (!input || typeof input !== "object") return base;

	const raw = input;
	const notes: Record<string, NotePracticeState> = {};
	if (raw.notes && typeof raw.notes === "object") {
		for (const [path, note] of Object.entries(raw.notes)) {
			if (!note || typeof note !== "object") continue;
			notes[path] = normalizeNoteState(path, note);
		}
	}
	const index: Record<string, NoteIndexEntry> = {};
	if (raw.index && typeof raw.index === "object") {
		for (const [path, entry] of Object.entries(raw.index)) {
			if (!entry || typeof entry !== "object") continue;
			index[path] = normalizeIndexEntry(path, entry);
		}
	}

	return {
		version: 1,
		notes,
		index,
		daily: {
			lastReminderDate: stringOrEmpty(raw.daily?.lastReminderDate),
			lastReminderAttemptAt: clampNumber(raw.daily?.lastReminderAttemptAt, 0, Number.MAX_SAFE_INTEGER, 0),
			lastPracticeDate: stringOrEmpty(raw.daily?.lastPracticeDate),
			streak: clampNumber(raw.daily?.streak, 0, 36500, 0),
			lastScanAt: clampNumber(raw.daily?.lastScanAt, 0, Number.MAX_SAFE_INTEGER, 0),
		},
		questionFeedback: normalizeQuestionFeedback(raw.questionFeedback),
	};
}

export function reconcilePracticeMemory(
	memory: PracticeMemory | undefined,
	topics: TopicNote[],
	now = Date.now()
): PracticeMemory {
	const next = normalizePracticeMemory(memory);
	const notes = { ...next.notes };
	const activePaths = new Set(topics.map((topic) => topic.path));
	const migratedPaths = new Set<string>();

	for (const topic of topics) {
		const carried = notes[topic.path]
			? { path: topic.path, state: notes[topic.path]! }
			: findCarryForwardState(notes, topic, activePaths, migratedPaths);
		const existing = carried?.state;
		if (carried && carried.path !== topic.path) migratedPaths.add(carried.path);
		const createdAt = topic.createdAt ?? existing?.createdAt ?? now;
		const updatedAt = topic.updatedAt ?? existing?.updatedAt ?? createdAt;
		const skill = clampNumber(topic.skill, 0, 100, existing?.skill ?? 50);
		const practicedAfterKnownUpdate =
			(existing?.lastPracticedAt ?? 0) > 0 &&
			updatedAt > (existing?.updatedAt ?? 0) + 1000;

		const dueAt = existing
			? practicedAfterKnownUpdate
				? Math.min(existing.dueAt, now)
				: existing.dueAt
			: now;
		// An edit after practice partially invalidates the memory model for the
		// note: some content is new, some is intact. Halve stability (rather than
		// resetting it) so the note comes back soon but recovers quickly if the
		// change was minor. Fires once per observed edit, because updatedAt is
		// persisted below.
		const stabilityDays = practicedAfterKnownUpdate
			? partialStabilityReset(existing?.stabilityDays ?? 0)
			: existing?.stabilityDays ?? 0;

		notes[topic.path] = {
			path: topic.path,
			title: topic.title,
			skill,
			createdAt,
			updatedAt,
			lastPracticedAt: existing?.lastPracticedAt ?? 0,
			dueAt,
			attempts: existing?.attempts ?? 0,
			correct: existing?.correct ?? 0,
			skipped: existing?.skipped ?? 0,
			correctStreak: existing?.correctStreak ?? 0,
			stabilityDays,
			averageTimeMs: existing?.averageTimeMs ?? 0,
			lastSessionAccuracy: existing?.lastSessionAccuracy ?? 0,
			lastSessionFluency: existing?.lastSessionFluency ?? 0,
			practicedSubtopics: existing?.practicedSubtopics ?? {},
		};
	}

	for (const path of migratedPaths) {
		delete notes[path];
	}
	next.notes = notes;
	next.daily.lastScanAt = now;
	return next;
}

export function applyPracticeMemoryToTopics(
	topics: TopicNote[],
	memory: PracticeMemory | undefined,
	now = Date.now()
): TopicNote[] {
	const reconciled = reconcilePracticeMemory(memory, topics, now);
	return topics.map((topic) => {
		const state = reconciled.notes[topic.path];
		if (!state) return topic;
		return {
			...topic,
			skill: state.skill,
			lastPracticedAt: state.lastPracticedAt || undefined,
			dueAt: state.dueAt,
		};
	});
}

export function selectDailyTopics(
	topics: TopicNote[],
	memory: PracticeMemory | undefined,
	limit: number,
	now = Date.now()
): TopicNote[] {
	const reconciled = reconcilePracticeMemory(memory, topics, now);
	const safeLimit = Math.max(1, limit);
	const scored = topics
		.map((topic) => scoreTopic(topic, reconciled, now))
		.sort((a, b) => b.score - a.score);
	const due = scored.filter((item) => {
		const state = reconciled.notes[item.topic.path];
		if (!state) return false;
		const practicedToday =
			state.lastPracticedAt > 0 &&
			localDateKey(new Date(state.lastPracticedAt)) === localDateKey(new Date(now));
		const modifiedAfterPractice =
			state.lastPracticedAt > 0 && state.updatedAt > state.lastPracticedAt + 1000;
		return (
			state.dueAt <= now ||
			state.attempts === 0 ||
			modifiedAfterPractice ||
			(!practicedToday && item.score >= 1.25)
		);
	});
	const pool = due.length > 0 ? due : scored.filter((item) => item.score >= 1.25);
	const selected = selectDailyTopicMix(pool, reconciled, safeLimit, now);

	return selected.map((item) => ({
		...item.topic,
		priorityScore: item.score,
		scheduleReason: item.reason,
		dueAt: reconciled.notes[item.topic.path]?.dueAt,
		lastPracticedAt: reconciled.notes[item.topic.path]?.lastPracticedAt || undefined,
	}));
}

/** Notes created within this window are in the learning phase: recall is
 * cheapest to consolidate NOW, so they outrank the new-material throttle. */
const LEARNING_PHASE_MS = 48 * 60 * 60 * 1000;

function selectDailyTopicMix(
	pool: TopicScore[],
	memory: PracticeMemory,
	limit: number,
	now = Date.now()
): TopicScore[] {
	const reviewed = pool.filter((item) => {
		const state = memory.notes[item.topic.path];
		return !!state && state.attempts > 0;
	});
	const untouchedAll = pool.filter((item) => {
		const state = memory.notes[item.topic.path];
		return !!state && state.attempts === 0;
	});
	// Forgetting-curve priority: just-created notes first (newest at the
	// front), THEN older untouched material. Without this, a vault full of
	// old never-practiced notes buries the notes made today and yesterday —
	// exactly the ones whose recall decays fastest.
	const createdAt = (item: TopicScore) =>
		memory.notes[item.topic.path]?.createdAt ?? item.topic.createdAt ?? 0;
	const fresh = untouchedAll
		.filter((item) => now - createdAt(item) <= LEARNING_PHASE_MS)
		.sort(
			(a, b) =>
				createdAt(a) - createdAt(b) ||
				(a.topic.fileCreatedAt ?? 0) - (b.topic.fileCreatedAt ?? 0)
		);
	// Older untouched notes carry no recency signal worth preserving —
	// shuffle so the same stale notes don't lead every session. Seeded by
	// the calendar day: the plan stays stable across refreshes within a day
	// but rotates daily.
	const older = untouchedAll.filter((item) => now - createdAt(item) > LEARNING_PHASE_MS);
	let seed = 0;
	for (const ch of localDateKey(new Date(now))) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
	const rand = () => {
		seed = (seed + 0x6d2b79f5) >>> 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	for (let i = older.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[older[i], older[j]] = [older[j]!, older[i]!];
	}
	const untouched = [...fresh, ...older];

	// A vault with no practiced notes yet has no review debt to displace, so
	// day one honors the user's topic limit outright.
	if (reviewed.length === 0) return untouched.slice(0, limit);

	// Old AND new every day: reserve slots for never-practiced notes so a
	// large review backlog cannot crowd fresh material out entirely — and
	// every learning-phase note gets a seat (capped at half the session).
	const reservedNew = Math.min(
		Math.max(2, fresh.length),
		untouched.length,
		Math.max(0, limit - 1),
		Math.max(1, Math.ceil(limit / 2))
	);
	const selected = reviewed.slice(0, limit - reservedNew);
	const remaining = limit - selected.length;
	if (remaining <= 0) return selected;

	// New-material throttle: once reviews exist, older never-practiced notes
	// stay capped at three per session, but learning-phase notes ride above
	// the cap — novelty must not displace review debt, except when the
	// novelty is what the learner studied in the last two days.
	const maxUntouched = Math.max(
		reservedNew,
		Math.min(Math.max(3, fresh.length), Math.ceil(limit / 2))
	);
	selected.push(...untouched.slice(0, Math.min(remaining, maxUntouched)));
	// Backfill with remaining due reviews if fewer new notes existed than the
	// reservation assumed.
	if (selected.length < limit) {
		const chosen = new Set(selected);
		for (const item of reviewed) {
			if (selected.length >= limit) break;
			if (!chosen.has(item)) {
				selected.push(item);
				chosen.add(item);
			}
		}
	}
	return selected;
}

export function selectPracticeMoreTopics(
	topics: TopicNote[],
	memory: PracticeMemory | undefined,
	limit: number,
	now = Date.now()
): TopicNote[] {
	const reconciled = reconcilePracticeMemory(memory, topics, now);
	const today = localDateKey(new Date(now));
	const scored = topics
		.map((topic, index) => {
			const item = scoreTopic(topic, reconciled, now);
			const state = reconciled.notes[topic.path];
			const practicedToday =
				!!state?.lastPracticedAt &&
				localDateKey(new Date(state.lastPracticedAt)) === today;
			const untouchedBoost = state?.attempts === 0 ? 0.9 : 0;
			const recentPenalty = practicedToday ? 1.8 : 0;
			const extraScore = item.score + untouchedBoost - recentPenalty;
			return {
				...item,
				index,
				extraScore,
				practicedToday,
			};
		})
		.sort((a, b) => b.extraScore - a.extraScore || a.index - b.index);

	return scored.slice(0, Math.max(1, limit)).map((item) => ({
		...item.topic,
		priorityScore: item.extraScore,
		scheduleReason: item.practicedToday
			? `extra practice, ${item.reason}`
			: item.reason,
		dueAt: reconciled.notes[item.topic.path]?.dueAt,
		lastPracticedAt: reconciled.notes[item.topic.path]?.lastPracticedAt || undefined,
	}));
}

export function planDailySession(
	topics: TopicNote[],
	memory: PracticeMemory | undefined,
	preferredQuestionCount: number
): DailySessionPlan {
	const baseCount = clampNumber(preferredQuestionCount, 3, 20, 8);
	if (topics.length === 0) {
		return {
			questionCount: baseCount,
			challengeMode: "steady",
			reason: "no topics selected",
		};
	}

	const reconciled = normalizePracticeMemory(memory);
	const states = topics
		.map((topic) => reconciled.notes[topic.path])
		.filter((state): state is NotePracticeState => !!state);
	const practiced = states.filter((state) => state.attempts > 0);
	const newRatio = states.length > 0
		? states.filter((state) => state.attempts === 0).length / states.length
		: 0;
	const averageSkill = average(states.map((state) => state.skill), 50);
	const averageAccuracy = average(
		practiced.map((state) => state.lastSessionAccuracy || successRate(state)),
		0.74
	);
	const averageFluency = average(
		practiced.map((state) => state.lastSessionFluency || 0.55),
		0.62
	);
	const skipPressure = average(
		practiced.map((state) =>
			state.attempts > 0 ? state.skipped / state.attempts : 0
		),
		0
	);
	const averageCorrectStreak = average(
		practiced.map((state) => state.correctStreak),
		0
	);
	const strongRecentPerformance =
		practiced.length > 0 &&
		averageAccuracy >= 0.9 &&
		averageFluency >= 0.72 &&
		skipPressure < 0.08 &&
		averageCorrectStreak >= 3;

	const fragile =
		(averageSkill < 45 && !strongRecentPerformance) ||
		averageAccuracy < 0.62 ||
		averageFluency < 0.48 ||
		skipPressure >= 0.18 ||
		newRatio >= 0.6;

	if (fragile) {
		return {
			questionCount: baseCount,
			challengeMode: "warmup",
			reason: summarizePlanReason([
				averageSkill < 45 ? "low skill" : "",
				averageAccuracy < 0.62 ? "recent misses" : "",
				averageFluency < 0.48 ? "slow recall" : "",
				skipPressure >= 0.18 ? "skips" : "",
				newRatio >= 0.6 ? "mostly new notes" : "",
			]),
		};
	}

	const cruising =
		practiced.length > 0 &&
		averageSkill >= 72 &&
		averageAccuracy >= 0.88 &&
		averageFluency >= 0.78 &&
		skipPressure < 0.08 &&
		newRatio < 0.4;

	if (cruising) {
		return {
			questionCount: baseCount,
			challengeMode: "stretch",
			reason: "strong recent accuracy and fluency",
		};
	}

	const momentumStretch =
		strongRecentPerformance &&
		newRatio < 0.55 &&
		(averageSkill >= 45 || averageCorrectStreak >= 4);

	if (momentumStretch) {
		return {
			questionCount: baseCount,
			challengeMode: "stretch",
			reason: "recent correct streak and fluent answers",
		};
	}

	return {
		questionCount: baseCount,
		challengeMode: "steady",
		reason: "balanced challenge",
	};
}

export function updatePracticeMemoryAfterSession(
	memory: PracticeMemory | undefined,
	topics: TopicNote[],
	results: QuizResult[],
	deltas: SkillDelta[],
	now = Date.now(),
	options: PracticeMemoryUpdateOptions = {}
): PracticeMemory {
	const next = reconcilePracticeMemory(memory, topics, now);
	const statsByPath = collectSessionStats(topics, results);
	const deltasByPath = new Map(deltas.map((delta) => [delta.path, delta]));

	for (const [path, stats] of statsByPath) {
		const state = next.notes[path];
		if (!state || stats.attempts === 0) continue;

		const delta = deltasByPath.get(path);
		const skill = clampNumber(delta?.after, 0, 100, state.skill);
		const sessionRate = stats.correct / stats.attempts;
		const sessionFluency = stats.fluencySum / stats.attempts;
		const sessionAverageTime = stats.totalTimeMs / stats.attempts;
		const skipRate = stats.skipped / stats.attempts;
		const elapsedDays = state.lastPracticedAt > 0
			? Math.max(0, (now - state.lastPracticedAt) / MS_PER_DAY)
			: 0;
		const newStability = nextStabilityDays(
			state.stabilityDays,
			elapsedDays,
			skill,
			sessionRate,
			sessionFluency,
			skipRate
		);
		const intervalDays = Math.max(
			1,
			Math.round(intervalForRetention(newStability, options.targetRetention))
		);

		state.skill = skill;
		state.attempts += stats.attempts;
		state.correct += stats.correct;
		state.skipped += stats.skipped;
		state.correctStreak =
			stats.correct === stats.attempts
				? state.correctStreak + stats.attempts
				: Math.max(0, state.correctStreak - (stats.attempts - stats.correct));
		state.lastPracticedAt = now;
		// Persist the compounding FSRS stability (float) so intervals can expand
		// across reviews instead of being recomputed from scratch each time.
		state.stabilityDays = newStability;
		state.dueAt = now + intervalDays * MS_PER_DAY;
		state.averageTimeMs = state.averageTimeMs > 0
			? state.averageTimeMs * 0.65 + sessionAverageTime * 0.35
			: sessionAverageTime;
		state.lastSessionAccuracy = sessionRate;
		state.lastSessionFluency = sessionFluency;

		for (const [subtopic, subStats] of stats.subtopics) {
			const key = normalizeSubtopicKey(subtopic);
			if (!key) continue;
			const previous = state.practicedSubtopics[key] ?? {
				lastPracticedAt: 0,
				attempts: 0,
				correct: 0,
			};
			const subElapsedDays = previous.lastPracticedAt > 0
				? Math.max(0, (now - previous.lastPracticedAt) / MS_PER_DAY)
				: 0;
			const subRate = subStats.attempts > 0
				? subStats.correct / subStats.attempts
				: 0;
			state.practicedSubtopics[key] = {
				lastPracticedAt: now,
				attempts: previous.attempts + subStats.attempts,
				correct: previous.correct + subStats.correct,
				// DAS3H-style component memory: each subtopic carries its own
				// stability so a note's weakest concept can pull it back before
				// the note-level schedule would.
				stabilityDays: nextStabilityDays(
					previous.stabilityDays ?? 0,
					subElapsedDays,
					skill,
					subRate,
					sessionFluency,
					0
				),
			};
		}
	}

	if (
		options.countDailyCredit === true &&
		evaluatePracticeSessionMeaningfulness(results).meaningful
	) {
		updateDailyStreak(next, now);
	}
	return next;
}

export function isMeaningfulPracticeSession(results: QuizResult[]): boolean {
	return evaluatePracticeSessionMeaningfulness(results).meaningful;
}

export function evaluatePracticeSessionMeaningfulness(
	results: QuizResult[]
): PracticeMeaningfulnessEvaluation {
	const answered = compactQuizResults(results);
	if (answered.length === 0) {
		return {
			meaningful: false,
			reason: "no-answers",
			detail: "No answered questions were submitted.",
		};
	}

	const attempted = answered.filter((result) => !result.skipped);
	const totalSlots = Math.max(results.length, answered.length);
	const minimumAttempts = Math.min(
		totalSlots,
		Math.max(2, Math.ceil(totalSlots * 0.5))
	);
	if (attempted.length < minimumAttempts) {
		return {
			meaningful: false,
			reason: "too-few-attempts",
			detail: `Attempt at least ${minimumAttempts} non-skipped question${minimumAttempts === 1 ? "" : "s"} for streak credit.`,
		};
	}

	const attemptedTimeMs = attempted.reduce(
		(sum, result) => sum + Math.max(0, result.timeTakenMs),
		0
	);
	const expectedAttemptedTimeMs = attempted.reduce(
		(sum, result) => sum + expectedTimeMs(result.question),
		0
	);
	const averageAttemptTimeMs = attemptedTimeMs / attempted.length;
	const timeRatio = expectedAttemptedTimeMs > 0
		? attemptedTimeMs / expectedAttemptedTimeMs
		: 0;
	const correct = attempted.filter((result) => result.isCorrect).length;

	if (averageAttemptTimeMs < 10_000) {
		return {
			meaningful: false,
			reason: "too-fast-average",
			detail: "Answers were too fast to count as deliberate practice.",
		};
	}
	if (attempted.length > 2 && attemptedTimeMs < 30_000) {
		return {
			meaningful: false,
			reason: "too-fast-total",
			detail: "The session finished too quickly to count toward the streak.",
		};
	}
	if (timeRatio < 0.1) {
		return {
			meaningful: false,
			reason: "too-fast-relative",
			detail: "The answers were much faster than the expected time for these questions.",
		};
	}

	if (correct > 0 || averageAttemptTimeMs >= 45_000) {
		return {
			meaningful: true,
			reason: "engaged",
			detail: "This session had enough deliberate answers to count for today.",
		};
	}
	return {
		meaningful: false,
		reason: "no-demonstrated-recall",
		detail: "A counted streak needs at least one correct answer or a longer reflective attempt.",
	};
}

export function localDateKey(date: Date): string {
	const yyyy = date.getFullYear();
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function reminderTimeHasPassed(reminderTime: string, now = new Date()): boolean {
	const match = /^(\d{1,2}):(\d{2})$/.exec(reminderTime);
	if (!match) return false;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
	const nowMinutes = now.getHours() * 60 + now.getMinutes();
	return nowMinutes >= hour * 60 + minute;
}

export function reminderAttemptCooldownHasPassed(
	lastAttemptAt: number,
	now = Date.now(),
	cooldownMs = REMINDER_RETRY_COOLDOWN_MS
): boolean {
	return lastAttemptAt <= 0 || now - lastAttemptAt >= cooldownMs;
}

export function shouldOfferDailyReminder(input: {
	enabled: boolean;
	reminderTime: string;
	memory: PracticeMemory | undefined;
	now?: Date;
	hasPracticeDraft?: boolean;
	generationInProgress?: boolean;
	noticeActive?: boolean;
}): boolean {
	if (!input.enabled) return false;
	if (input.hasPracticeDraft || input.generationInProgress || input.noticeActive) {
		return false;
	}

	const now = input.now ?? new Date();
	const memory = normalizePracticeMemory(input.memory);
	const today = localDateKey(now);
	if (memory.daily.lastPracticeDate === today) return false;
	if (memory.daily.lastReminderDate === today) return false;
	if (!reminderTimeHasPassed(input.reminderTime, now)) return false;
	return reminderAttemptCooldownHasPassed(
		memory.daily.lastReminderAttemptAt,
		now.getTime()
	);
}

export function recordDailyReminderAttempt(
	memory: PracticeMemory | undefined,
	now = Date.now()
): PracticeMemory {
	const next = normalizePracticeMemory(memory);
	next.daily.lastReminderAttemptAt = now;
	return next;
}

export function suppressDailyReminderForToday(
	memory: PracticeMemory | undefined,
	now = new Date()
): PracticeMemory {
	const next = normalizePracticeMemory(memory);
	next.daily.lastReminderDate = localDateKey(now);
	next.daily.lastReminderAttemptAt = now.getTime();
	return next;
}

function normalizeNoteState(path: string, note: NotePracticeState): NotePracticeState {
	return {
		path,
		title: stringOrEmpty(note.title) || path,
		skill: clampNumber(note.skill, 0, 100, 50),
		createdAt: clampNumber(note.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
		updatedAt: clampNumber(note.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
		lastPracticedAt: clampNumber(note.lastPracticedAt, 0, Number.MAX_SAFE_INTEGER, 0),
		dueAt: clampNumber(note.dueAt, 0, Number.MAX_SAFE_INTEGER, 0),
		attempts: clampNumber(note.attempts, 0, Number.MAX_SAFE_INTEGER, 0),
		correct: clampNumber(note.correct, 0, Number.MAX_SAFE_INTEGER, 0),
		skipped: clampNumber(note.skipped, 0, Number.MAX_SAFE_INTEGER, 0),
		correctStreak: clampNumber(note.correctStreak, 0, Number.MAX_SAFE_INTEGER, 0),
		stabilityDays: clampNumber(note.stabilityDays, 0, 36500, 0),
		averageTimeMs: clampNumber(note.averageTimeMs, 0, Number.MAX_SAFE_INTEGER, 0),
		lastSessionAccuracy: clampNumber(note.lastSessionAccuracy, 0, 1, 0),
		lastSessionFluency: clampNumber(note.lastSessionFluency, 0, 1, 0),
		practicedSubtopics:
			note.practicedSubtopics && typeof note.practicedSubtopics === "object"
				? note.practicedSubtopics
				: {},
	};
}

function findCarryForwardState(
	notes: Record<string, NotePracticeState>,
	topic: TopicNote,
	activePaths: Set<string>,
	migratedPaths: Set<string>
): { path: string; state: NotePracticeState } | null {
	const scored = Object.entries(notes)
		.filter(([path]) => path !== topic.path && !activePaths.has(path) && !migratedPaths.has(path))
		.map(([path, state]) => ({
			path,
			state,
			score: carryForwardScore(state, topic),
		}))
		.filter(({ score }) => score >= 4)
		.sort((a, b) => b.score - a.score);
	const best = scored[0];
	return best ? { path: best.path, state: best.state } : null;
}

function carryForwardScore(state: NotePracticeState, topic: TopicNote): number {
	const titleScore = topicTitleSimilarity(state.title, topic.title);
	const titleExact = normalizeTitle(state.title) === normalizeTitle(topic.title);
	const createdClose = isCloseTimestamp(state.createdAt, topic.createdAt);
	const updatedClose = isCloseTimestamp(state.updatedAt, topic.updatedAt);

	if (!titleExact && titleScore < 0.62) return 0;

	let score = titleExact ? 4 : titleScore * 3;
	if (createdClose) score += 1.5;
	if (updatedClose) score += 1.5;
	if (sameExtension(state.path, topic.path)) score += 0.5;
	return score;
}

function topicTitleSimilarity(a: string, b: string): number {
	const aKey = normalizeTitle(a);
	const bKey = normalizeTitle(b);
	if (!aKey || !bKey) return 0;
	if (aKey === bKey) return 1;
	if (aKey.length >= 8 && bKey.includes(aKey)) return 0.85;
	if (bKey.length >= 8 && aKey.includes(bKey)) return 0.85;

	const aTokens = new Set(aKey.split(" ").filter((token) => token.length > 2));
	const bTokens = new Set(bKey.split(" ").filter((token) => token.length > 2));
	if (aTokens.size === 0 || bTokens.size === 0) return 0;
	let overlap = 0;
	for (const token of aTokens) {
		if (bTokens.has(token)) overlap++;
	}
	return overlap / Math.max(aTokens.size, bTokens.size);
}

function normalizeTitle(value: string): string {
	return value
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[_-]+/g, " ")
		.replace(/[^a-z0-9 ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function isCloseTimestamp(a: number, b: number | undefined): boolean {
	if (!a || !b) return false;
	return Math.abs(a - b) <= 5_000;
}

function sameExtension(a: string, b: string): boolean {
	return extensionOf(a) === extensionOf(b);
}

function extensionOf(path: string): string {
	return path.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeIndexEntry(
	path: string,
	entry: Partial<NoteIndexEntry>
): NoteIndexEntry {
	const extension = stringOrEmpty(entry.extension);
	const isPdf = typeof entry.isPdf === "boolean" ? entry.isPdf : extension === "pdf";
	return {
		path,
		title: stringOrEmpty(entry.title) || path,
		aliases: normalizeStringArray(entry.aliases),
		extension,
		isPdf,
		frontmatter: normalizeStringRecord(entry.frontmatter),
		tags: normalizeStringArray(entry.tags),
		links: normalizeStringArray(entry.links),
		headings: normalizeHeadings(entry.headings),
		media: normalizeMedia(entry.media),
		estimatedWordCount: clampNumber(entry.estimatedWordCount, 0, Number.MAX_SAFE_INTEGER, 0),
		size: clampNumber(entry.size, 0, Number.MAX_SAFE_INTEGER, 0),
		skill: clampNumber(entry.skill, 0, 100, 50),
		createdAt: clampNumber(entry.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
		updatedAt: clampNumber(entry.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
		fileCreatedAt: clampNumber(
			entry.fileCreatedAt,
			0,
			Number.MAX_SAFE_INTEGER,
			clampNumber(entry.createdAt, 0, Number.MAX_SAFE_INTEGER, 0)
		),
		fileUpdatedAt: clampNumber(
			entry.fileUpdatedAt,
			0,
			Number.MAX_SAFE_INTEGER,
			clampNumber(entry.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0)
		),
		indexedAt: clampNumber(entry.indexedAt, 0, Number.MAX_SAFE_INTEGER, 0),
	};
}

function normalizeStringRecord(input: unknown): Record<string, string> {
	if (!input || typeof input !== "object") return {};
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === "string") output[key] = value;
	}
	return output;
}

function normalizeStringArray(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return input.filter((item): item is string => typeof item === "string");
}

function normalizeHeadings(input: unknown): NoteHeading[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item): NoteHeading | null => {
			if (!item || typeof item !== "object") return null;
			const raw = item as Partial<NoteHeading>;
			const heading = stringOrEmpty(raw.heading);
			if (!heading) return null;
			return {
				heading,
				level: clampNumber(raw.level, 0, 6, 0),
			};
		})
		.filter((item): item is NoteHeading => item !== null);
}

function normalizeMedia(input: unknown): NoteIndexMedia[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((item): NoteIndexMedia | null => {
			if (!item || typeof item !== "object") return null;
			const raw = item as Partial<NoteIndexMedia>;
			const path = stringOrEmpty(raw.path);
			if (!path) return null;
			return {
				path,
				kind: raw.kind === "image" || raw.kind === "pdf" || raw.kind === "svg"
					? raw.kind
					: "unknown",
				mimeType: stringOrEmpty(raw.mimeType),
				size: clampNumber(raw.size, 0, Number.MAX_SAFE_INTEGER, 0),
				alt: stringOrEmpty(raw.alt),
				source: raw.source === "remote" ? "remote" : "local",
				url: stringOrEmpty(raw.url),
				caption: stringOrEmpty(raw.caption),
			};
		})
		.filter((item): item is NoteIndexMedia => item !== null);
}

function scoreTopic(topic: TopicNote, memory: PracticeMemory, now: number): TopicScore {
	const state = memory.notes[topic.path];
	if (!state) return { topic, score: 0, reason: "not indexed yet" };

	const daysOverdue = Math.max(0, (now - state.dueAt) / MS_PER_DAY);
	const daysSincePractice =
		state.lastPracticedAt > 0 ? (now - state.lastPracticedAt) / MS_PER_DAY : 30;
	const skillGap = (100 - state.skill) / 100;
	const touchedToday = wasTouchedToday(state, now);
	const modifiedAfterPractice =
		state.lastPracticedAt > 0 && state.updatedAt > state.lastPracticedAt + 1000;
	const dueBase = state.dueAt <= now ? 2 : 0;
	const freshBoost = touchedToday ? 1.2 : 0;
	const changeBoost = modifiedAfterPractice ? 1.1 : 0;
	const newBoost = state.attempts === 0 ? 1.4 : 0;
	const spacingBoost = Math.min(daysSincePractice / 14, 1.25);
	const fragileBoost = state.attempts > 0
		? Math.max(0, (0.72 - state.lastSessionAccuracy) * 1.4) +
			Math.max(0, (0.55 - state.lastSessionFluency) * 1.1)
		: 0;
	const weakSubtopic = weakestSubtopicRetrievability(state, now);
	const subtopicBoost = weakSubtopic
		? Math.max(0, 0.85 - weakSubtopic.retrievability) * 1.6
		: 0;
	const score =
		dueBase +
		daysOverdue * 0.75 +
		skillGap * 1.6 +
		freshBoost +
		changeBoost +
		newBoost +
		spacingBoost +
		fragileBoost +
		subtopicBoost;

	const reasons: string[] = [];
	if (state.attempts === 0) reasons.push("new");
	if (state.dueAt <= now) reasons.push("due");
	if (touchedToday) reasons.push("created/updated today");
	if (modifiedAfterPractice) reasons.push("changed since last practice");
	if (state.skill < 55) reasons.push("low skill");
	if (state.lastSessionAccuracy > 0 && state.lastSessionAccuracy < 0.7) {
		reasons.push("recent misses");
	}
	if (state.lastSessionFluency > 0 && state.lastSessionFluency < 0.55) {
		reasons.push("slow recall");
	}
	if (weakSubtopic && weakSubtopic.retrievability < 0.7) {
		reasons.push(`fading subtopic: ${weakSubtopic.name}`);
	}
	if (reasons.length === 0) reasons.push("spacing");

	return { topic, score, reason: reasons.join(", ") };
}

/**
 * The weakest practiced subtopic's predicted recall, DAS3H-style: due-ness can
 * key off a single fading concept even when the note as a whole is not due.
 * Subtopics need >=2 attempts so one noisy label cannot drag a note back.
 */
function weakestSubtopicRetrievability(
	state: NotePracticeState,
	now: number
): { name: string; retrievability: number } | null {
	let weakest: { name: string; retrievability: number } | null = null;
	for (const [name, sub] of Object.entries(state.practicedSubtopics)) {
		const stability = sub.stabilityDays ?? 0;
		if (sub.attempts < 2 || stability <= 0 || sub.lastPracticedAt <= 0) continue;
		const elapsedDays = Math.max(0, (now - sub.lastPracticedAt) / MS_PER_DAY);
		const r = retrievability(stability, elapsedDays);
		if (!weakest || r < weakest.retrievability) {
			weakest = { name, retrievability: r };
		}
	}
	return weakest;
}

function wasTouchedToday(state: NotePracticeState, now: number): boolean {
	const today = localDateKey(new Date(now));
	return (
		localDateKey(new Date(state.createdAt)) === today ||
		localDateKey(new Date(state.updatedAt)) === today
	);
}

function collectSessionStats(
	topics: TopicNote[],
	results: QuizResult[]
): Map<string, SessionTopicStats> {
	// Titles are not unique in Obsidian, so map each title to every topic that
	// carries it and attribute results by path. This keeps two same-titled notes
	// from corrupting each other's learning state.
	const titleToTopics = new Map<string, TopicNote[]>();
	for (const topic of topics) {
		const list = titleToTopics.get(topic.title) ?? [];
		list.push(topic);
		titleToTopics.set(topic.title, list);
	}
	const byPath = new Map<string, SessionTopicStats>();

	for (const result of compactQuizResults(results)) {
		const sourceTopics = reconcileSourceTopics(
			result.question.sourceTopics,
			topics
		);
		for (const title of sourceTopics) {
			for (const topic of titleToTopics.get(title) ?? []) {
				const stats = byPath.get(topic.path) ?? {
					attempts: 0,
					correct: 0,
					skipped: 0,
					totalTimeMs: 0,
					fluencySum: 0,
					subtopics: new Map<string, { attempts: number; correct: number }>(),
				};
				stats.attempts += 1;
				if (result.isCorrect) stats.correct += 1;
				if (result.skipped) stats.skipped += 1;
				stats.totalTimeMs += result.timeTakenMs;
				stats.fluencySum += resultFluency(result);
				for (const subtopic of result.question.sourceSubtopics ?? []) {
					const existing = stats.subtopics.get(subtopic) ?? { attempts: 0, correct: 0 };
					existing.attempts += 1;
					if (result.isCorrect) existing.correct += 1;
					stats.subtopics.set(subtopic, existing);
				}
				byPath.set(topic.path, stats);
			}
		}
	}

	return byPath;
}

// --- FSRS-style spaced repetition (difficulty / stability / retrievability) ---
//
// Grounded in the Free Spaced Repetition Scheduler's power forgetting curve and
// DSR model, simplified to fixed interpretable constants (no per-user training):
//   - Retrievability decays as a power law: R(t) = (1 + FACTOR·t/S)^DECAY, so
//     R(S) = TARGET by construction.
//   - Stability COMPOUNDS on success (the spacing effect: a successful recall of
//     an overdue/low-R item strengthens memory more), and resets low on a lapse
//     so a forgotten note resurfaces within a few days regardless of prior S.
//   - Difficulty is derived from the note's skill and damps growth for hard notes.
// This replaces the previous ungrounded magic-number buckets whose `stabilityDays`
// never compounded, so mature notes were re-asked roughly every 1–3 weeks forever.

const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81; // makes R(S) == DEFAULT_TARGET_RETENTION
export const DEFAULT_TARGET_RETENTION = 0.9;
const MIN_STABILITY_DAYS = 0.5;
const LAPSE_STABILITY_CAP_DAYS = 3;
const STABILITY_GROWTH_BASE = 1.5;

export function retrievability(stabilityDays: number, elapsedDays: number): number {
	if (stabilityDays <= 0) return 0;
	const t = Math.max(0, elapsedDays);
	return Math.pow(1 + FSRS_FACTOR * (t / stabilityDays), FSRS_DECAY);
}

export function intervalForRetention(
	stabilityDays: number,
	targetRetention: number = DEFAULT_TARGET_RETENTION
): number {
	const target = Math.min(0.97, Math.max(0.7, targetRetention));
	return stabilityDays * (Math.pow(target, 1 / FSRS_DECAY) - 1) / FSRS_FACTOR;
}

function difficultyFromSkill(skill: number): number {
	// Skill 100 -> easiest (1), skill 0 -> hardest (10).
	return 1 + 9 * (1 - clampNumber(skill, 0, 100, 50) / 100);
}

function sessionGrade(sessionRate: number, sessionFluency: number, skipRate: number): number {
	return clampNumber(
		sessionRate * (0.7 + 0.3 * sessionFluency) - skipRate * 0.2,
		0,
		1,
		0
	);
}

function initialStabilityDays(grade: number, difficulty: number): number {
	const base = 0.5 + grade * 4; // 0.5 .. 4.5 days
	const difficultyScale = 1.1 - (difficulty - 1) / 18; // ~1.1 (easy) .. ~0.6 (hard)
	return Math.max(MIN_STABILITY_DAYS, base * difficultyScale);
}

export function partialStabilityReset(stabilityDays: number): number {
	if (stabilityDays <= 0) return stabilityDays;
	return Math.max(MIN_STABILITY_DAYS, stabilityDays * 0.5);
}

export function nextStabilityDays(
	previousStability: number,
	elapsedDays: number,
	skill: number,
	sessionRate: number,
	sessionFluency: number,
	skipRate: number
): number {
	const difficulty = difficultyFromSkill(skill);
	const grade = sessionGrade(sessionRate, sessionFluency, skipRate);

	if (previousStability <= 0) {
		return initialStabilityDays(grade, difficulty);
	}

	if (sessionRate < 0.5) {
		// Lapse: bring the note back within a few days regardless of prior stability.
		return Math.max(
			MIN_STABILITY_DAYS,
			Math.min(previousStability * 0.25, LAPSE_STABILITY_CAP_DAYS)
		);
	}

	const r = retrievability(previousStability, elapsedDays);
	const easiness = (11 - difficulty) / 10; // ~1 (easy) .. 0.1 (hard)
	const overdueBoost = 1 + (1 - r); // 1 (fresh) .. 2 (forgotten but recalled)
	const growth = 1 + STABILITY_GROWTH_BASE * easiness * overdueBoost * grade;
	return Math.max(previousStability, previousStability * growth);
}

function updateDailyStreak(memory: PracticeMemory, now: number): void {
	const today = localDateKey(new Date(now));
	const yesterday = localDateKey(new Date(now - MS_PER_DAY));
	const last = memory.daily.lastPracticeDate;
	if (last === today) return;
	memory.daily.streak = last === yesterday ? memory.daily.streak + 1 : 1;
	memory.daily.lastPracticeDate = today;
}

function successRate(state: NotePracticeState): number {
	return state.attempts > 0 ? state.correct / state.attempts : 0;
}

function average(values: number[], fallback: number): number {
	const valid = values.filter((value) => Number.isFinite(value));
	if (valid.length === 0) return fallback;
	return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function summarizePlanReason(reasons: string[]): string {
	const present = reasons.filter(Boolean);
	return present.length > 0 ? present.join(", ") : "fragile recall";
}

function normalizeSubtopicKey(input: string): string {
	return input.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
}

function stringOrEmpty(input: unknown): string {
	return typeof input === "string" ? input : "";
}

function normalizeQuestionFeedback(input: unknown): QuestionFeedbackEntry[] {
	if (!Array.isArray(input)) return [];
	return input
		.map((entry) => normalizeQuestionFeedbackEntry(entry))
		.filter((entry): entry is QuestionFeedbackEntry => !!entry)
		.slice(-250);
}

function normalizeQuestionFeedbackEntry(input: unknown): QuestionFeedbackEntry | null {
	if (!input || typeof input !== "object") return null;
	const raw = input as Partial<QuestionFeedbackEntry>;
	if (
		raw.kind !== "too_easy" &&
		raw.kind !== "too_hard" &&
		raw.kind !== "bad_concept"
	) {
		return null;
	}
	if (
		raw.difficulty !== "easy" &&
		raw.difficulty !== "medium" &&
		raw.difficulty !== "hard"
	) {
		return null;
	}
	const id = stringOrEmpty(raw.id).trim();
	const questionText = stringOrEmpty(raw.questionText).trim();
	if (!id || !questionText) return null;
	return {
		id,
		kind: raw.kind,
		questionText,
		correctAnswer: stringOrEmpty(raw.correctAnswer).trim(),
		difficulty: raw.difficulty,
		sourceTopics: normalizeFeedbackStringArray(raw.sourceTopics),
		sourceSubtopics: normalizeFeedbackStringArray(raw.sourceSubtopics),
		wasCorrect: raw.wasCorrect === true,
		skipped: raw.skipped === true,
		timeTakenMs: clampNumber(raw.timeTakenMs, 0, 24 * 60 * 60 * 1000, 0),
		createdAt: clampNumber(raw.createdAt, 0, Number.MAX_SAFE_INTEGER, 0),
	};
}

function normalizeFeedbackStringArray(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	return [...new Set(input
		.filter((value): value is string => typeof value === "string")
		.map((value) => value.trim())
		.filter(Boolean))]
		.slice(0, 8);
}

function clampNumber(
	input: unknown,
	min: number,
	max: number,
	fallback: number
): number {
	if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
	return Math.min(max, Math.max(min, input));
}
