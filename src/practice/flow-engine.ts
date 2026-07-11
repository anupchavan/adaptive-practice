import {
	DailyChallengeMode,
	Difficulty,
	PracticeIntent,
	Question,
	QuestionFeedbackEntry,
	QuizResult,
	SessionConfig,
	TopicNote,
} from "../types";
import { buildPrompt, TopicContext } from "../llm/prompt";
import { buildFlowContinuationPrompt, mergeQuestionBatches } from "./question-quality";
import { generateQuestionsFromClient, LlmClient } from "./generation-loop";

/**
 * Just-in-time flow generation.
 *
 * Instead of generating a whole session up front (freezing difficulty before
 * the learner has answered anything), questions arrive in micro-batches and
 * each batch is conditioned on how the session is actually going. A rolling
 * controller nudges the effective difficulty to hold success around the
 * ~80-85% band that maximizes learning and engagement (the "85% rule",
 * Wilson et al. 2019; challenge-skill balance in flow research), with
 * hysteresis so the difficulty never whiplashes.
 */

export interface FlowSignal {
	isCorrect: boolean;
	skipped: boolean;
	timeTakenMs: number;
	difficulty: Difficulty;
}

export interface FlowAdjustment {
	/** Applied to each topic's effective skill for the next batch only. */
	skillDelta: number;
	note: string;
}

const FLOW_WINDOW = 6;
const FLOW_STEP = 10;
/** Generous per-difficulty "fluent" answer times. */
const EXPECTED_TIME_MS: Record<Difficulty, number> = {
	easy: 40_000,
	medium: 90_000,
	hard: 150_000,
};

export function toFlowSignals(results: QuizResult[]): FlowSignal[] {
	return results
		.filter((result): result is QuizResult => !!result)
		.map((result) => ({
			isCorrect: result.isCorrect && !result.skipped,
			skipped: result.skipped,
			timeTakenMs: result.timeTakenMs,
			difficulty: result.question.difficulty,
		}));
}

/**
 * The controller: look at the recent window and decide whether the next batch
 * should step up, ease off, or hold. Needs at least three answers before it
 * moves at all (hysteresis against noise).
 */
export function flowSkillAdjustment(signals: FlowSignal[]): FlowAdjustment {
	const window = signals.slice(-FLOW_WINDOW);
	if (window.length < 3) {
		return { skillDelta: 0, note: "flow: calibrating on the opening questions" };
	}
	// Skips signal avoidance, not failure: they push toward easing but must
	// not dilute accuracy — 3 correct of 4 answered is a 75% learner even if
	// a fifth question was skipped.
	const skips = window.filter((signal) => signal.skipped).length;
	const answered = window.filter((signal) => !signal.skipped);
	// Repeated skips read as overload even before enough answers accumulate.
	if (skips >= 2) {
		return {
			skillDelta: -FLOW_STEP,
			note: "flow: easing difficulty after repeated skips (protecting the ~80% success band)",
		};
	}
	if (answered.length < 3) {
		return { skillDelta: 0, note: "flow: calibrating on the opening questions" };
	}
	const accuracy = answered.filter((signal) => signal.isCorrect).length / answered.length;
	const fastRatio =
		answered.filter(
			(signal) =>
				signal.isCorrect &&
				signal.timeTakenMs > 0 &&
				signal.timeTakenMs <= EXPECTED_TIME_MS[signal.difficulty]
		).length / answered.length;

	if (accuracy <= 0.5) {
		return {
			skillDelta: -FLOW_STEP,
			note: "flow: easing difficulty after recent misses (protecting the ~80% success band)",
		};
	}
	if (accuracy >= 0.75) {
		// Above the target band, step up; fast AND highly accurate earns a
		// double step (crossing into the next difficulty mix band).
		return accuracy >= 0.85 && fastRatio >= 0.5
			? {
				skillDelta: FLOW_STEP * 2,
				note: "flow: raising challenge after fast, accurate answers (double step)",
			}
			: {
				skillDelta: FLOW_STEP,
				note: "flow: raising challenge after consistently correct answers",
			};
	}
	return { skillDelta: 0, note: "flow: steady in the target success band" };
}

/**
 * Micro-batch plan: an opening batch of three (fast time-to-first-question),
 * then batches of three, folding a trailing single question into the previous
 * batch so no round-trip is spent on one question.
 */
export function planFlowBatches(totalCount: number): number[] {
	const total = Math.max(1, Math.floor(totalCount));
	if (total <= 4) return [total];
	const batches: number[] = [];
	let remaining = total;
	while (remaining > 0) {
		if (remaining === 4) {
			batches.push(2, 2);
			break;
		}
		const size = Math.min(3, remaining);
		batches.push(size);
		remaining -= size;
	}
	return batches;
}

/**
 * Balanced chunks for generating a whole session up front. No chunk exceeds
 * the size a single request can reliably fit inside the 8192-token output
 * ceiling shared by every provider — a 20-question single call cannot fit and
 * truncates mid-JSON, which is exactly the failure this prevents.
 */
export const UPFRONT_CHUNK_SIZE = 8;

export function planUpfrontBatches(
	totalCount: number,
	maxChunk = UPFRONT_CHUNK_SIZE
): number[] {
	const total = Math.max(1, Math.floor(totalCount));
	const chunkCount = Math.ceil(total / Math.max(1, maxChunk));
	const base = Math.floor(total / chunkCount);
	const extra = total % chunkCount;
	return Array.from({ length: chunkCount }, (_, index) =>
		base + (index < extra ? 1 : 0)
	);
}

export function adjustTopicsForFlow(
	topics: TopicNote[],
	skillDelta: number
): TopicNote[] {
	if (skillDelta === 0) return topics;
	return topics.map((topic) => ({
		...topic,
		skill: Math.max(0, Math.min(100, topic.skill + skillDelta)),
	}));
}

export interface FlowPromptOptions {
	challengeMode?: DailyChallengeMode;
	challengeReason?: string;
	intent?: PracticeIntent;
	questionFeedback?: QuestionFeedbackEntry[];
}

/**
 * Drives one session's just-in-time generation. Pure orchestration over the
 * existing generation loop, so every batch still passes calibration, the
 * difficulty estimator, and the challenge-shortfall repair machinery.
 */
export class FlowSessionGenerator {
	private client: LlmClient;
	/** When set, verification runs in the background and this receives the
	 * surviving questions so the session can retract contested ones. */
	onBatchVerified?: (verified: Question[], original: Question[]) => void;

	noteRetracted(count: number): void {
		this.deficit += Math.max(0, count);
	}
	private contexts: TopicContext[];
	private config: SessionConfig;
	private promptOptions: FlowPromptOptions;
	private batches: number[];
	private batchIndex = 0;
	/** Running sum of controller deltas: sustained success must COMPOUND
	 * across batches (50→60→70 crosses mix bands) instead of hovering one
	 * step above base skill forever. Clamped so one session can't swing a
	 * topic from remedial to expert. */
	private flowDelta = 0;
	/** Questions retracted by background verification: the next batch grows
	 * by this much so the session still delivers the promised count. */
	private deficit = 0;

	constructor(
		client: LlmClient,
		contexts: TopicContext[],
		config: SessionConfig,
		promptOptions: FlowPromptOptions = {},
		batchPlan?: number[]
	) {
		this.client = client;
		this.contexts = contexts;
		this.config = config;
		this.promptOptions = promptOptions;
		this.batches = batchPlan ?? planFlowBatches(config.questionCount);
	}

	get totalPlanned(): number {
		return this.config.questionCount;
	}

	get exhausted(): boolean {
		return this.batchIndex >= this.batches.length;
	}

	async firstBatch(): Promise<Question[]> {
		this.batchIndex = 0;
		return this.generateBatch([], []);
	}

	/**
	 * Generate the next micro-batch conditioned on the session so far: the
	 * controller's difficulty adjustment plus the already-asked stems to avoid.
	 */
	async nextBatch(results: QuizResult[], asked: Question[]): Promise<Question[]> {
		if (this.exhausted) return [];
		return this.generateBatch(results, asked);
	}

	private async generateBatch(
		results: QuizResult[],
		asked: Question[]
	): Promise<Question[]> {
		let size = this.batches[this.batchIndex];
		if (!size) return [];
		if (this.deficit > 0) {
			size += this.deficit;
			this.deficit = 0;
		}
		const adjustment = flowSkillAdjustment(toFlowSignals(results));
		this.flowDelta = Math.max(-30, Math.min(40, this.flowDelta + adjustment.skillDelta));
		const topics = adjustTopicsForFlow(this.config.topics, this.flowDelta);
		const batchConfig: SessionConfig = {
			...this.config,
			topics,
			questionCount: size,
			challengeReason: adjustment.note,
		};
		const basePrompt = buildPrompt(this.contexts, size, {
			challengeMode: this.config.challengeMode,
			challengeReason: adjustment.note,
			intent: this.promptOptions.intent,
			questionFeedback: this.promptOptions.questionFeedback ?? [],
			now: Date.now(),
		});
		const prompt = asked.length > 0
			? buildFlowContinuationPrompt(basePrompt, asked, adjustment.note, size)
			: basePrompt;

		const batch = await generateQuestionsFromClient(
			this.client,
			prompt,
			batchConfig,
			this.contexts,
			this.onBatchVerified
		);
		this.batchIndex += 1;
		// Merge against everything already asked so a duplicated stem from the
		// model cannot appear twice in one session.
		return mergeQuestionBatches(asked, batch, asked.length + size).slice(asked.length);
	}
}
