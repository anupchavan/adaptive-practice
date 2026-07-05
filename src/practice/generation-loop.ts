import { StructuredPrompt, TopicContext } from "../llm/prompt";
import { Question, SessionConfig, TopicNote } from "../types";
import { reconcileGeneratedQuestions } from "./source-map";
import { buildDeepAuthoringPrompt, sharpenIndex } from "../llm/analytical-moves";
import { checkAnswer } from "./grader";
import {
	buildAnswerVerificationPrompt,
	buildChallengeTopUpPrompt,
	buildQuestionTopUpPrompt,
	mergeQuestionBatches,
} from "./question-quality";
import {
	challengeShortfallMessage,
	isStrictChallengeSession,
	prepareGeneratedQuestionsForSession,
	selectFlowBalancedQuestions,
	shouldRequestChallengeTopUp,
} from "./flow-calibration";
import { calibrateQuestionsForPractice } from "./question-calibration";

export interface LlmClient {
	generateQuestions(prompt: StructuredPrompt): Promise<Question[]>;
}

export async function generateQuestionsFromClient(
	client: LlmClient,
	prompt: StructuredPrompt,
	config: SessionConfig,
	topicContexts: TopicContext[]
): Promise<Question[]> {
	let questions = await generateUnverifiedQuestions(
		client,
		prompt,
		config,
		topicContexts
	);
	if (config.deepAuthoring === true && questions.length > 0) {
		questions = await sharpenQuestions(client, prompt, config, topicContexts, questions);
	}
	if (config.verifyAnswers !== true || questions.length === 0) return questions;
	return verifyQuestionAnswers(client, prompt, questions);
}

/**
 * Adversarial sharpen pass (opt-in). Sends the medium/hard questions back for
 * a hostile rewrite, then reconciles/calibrates the result like any other
 * batch. Best-effort and conservative: each returned rewrite replaces its own
 * original, questions the pass dropped or mangled keep their original version,
 * and any request failure keeps the whole batch untouched — the pass can only
 * improve or no-op, never shrink a session.
 */
async function sharpenQuestions(
	client: LlmClient,
	basePrompt: StructuredPrompt,
	config: SessionConfig,
	topicContexts: TopicContext[],
	questions: Question[]
): Promise<Question[]> {
	const plan = buildDeepAuthoringPrompt(basePrompt, questions);
	if (!plan) return questions;
	try {
		const sharpened = await requestReconciledQuestions(
			client,
			plan.prompt,
			config.topics,
			topicContexts
		);
		return applyDeepAuthoring(questions, plan.targets, sharpened);
	} catch {
		return questions;
	}
}

/**
 * Merge sharpened rewrites back over the original batch. Rewrites match their
 * originals by the minted sharpen ids ("s1"...); a model that renumbered
 * anyway is recovered positionally when the count came back exact, and
 * anything still unmatched keeps its original — ambiguity never replaces the
 * wrong question. Replacements keep the original id and difficulty so session
 * state, blind verification, and the already-validated flow balance stay
 * keyed correctly. `targets` must be the plan's target objects (drawn from
 * `original`); matching is by object identity, which duplicate model-assigned
 * ids in merged batches cannot confuse.
 */
export function applyDeepAuthoring(
	original: Question[],
	targets: Question[],
	sharpened: Question[]
): Question[] {
	if (targets.length === 0 || sharpened.length === 0) return original;
	const replacements = new Array<Question | undefined>(targets.length);
	let matched = 0;
	for (const question of sharpened) {
		const index = sharpenIndex(question.id);
		if (index !== null && index < targets.length && !replacements[index]) {
			replacements[index] = question;
			matched++;
		}
	}
	if (matched === 0) {
		if (sharpened.length !== targets.length) return original;
		sharpened.forEach((question, index) => {
			replacements[index] = question;
		});
	}
	const byTarget = new Map<Question, Question>();
	targets.forEach((target, index) => {
		const replacement = replacements[index];
		if (replacement) {
			byTarget.set(target, {
				...replacement,
				id: target.id,
				difficulty: target.difficulty,
			});
		}
	});
	if (byTarget.size === 0) return original;
	return original.map((question) => byTarget.get(question) ?? question);
}

/**
 * Blind re-solve pass: the batch goes back to the model with answers removed,
 * and any question whose marked answer disagrees with the independent
 * derivation is dropped. A shorter honest batch beats a full one with a wrong
 * key — the learner picking the right answer and being marked wrong is the
 * worst outcome this plugin can produce. Best-effort: any failure in the
 * verification request keeps the batch untouched.
 */
async function verifyQuestionAnswers(
	client: LlmClient,
	basePrompt: StructuredPrompt,
	questions: Question[]
): Promise<Question[]> {
	try {
		const reSolved = await client.generateQuestions(
			buildAnswerVerificationPrompt(basePrompt, questions)
		);
		return applyAnswerVerification(questions, reSolved);
	} catch {
		return questions;
	}
}

/**
 * Compare the original batch against the blind re-solve. Only an ACTIVE
 * disagreement drops a question — a question the verifier skipped or mangled
 * stays. If more than half the batch is contested, the verifier run itself is
 * the more likely fault, so the batch is kept whole.
 */
export function applyAnswerVerification(
	questions: Question[],
	reSolved: Question[]
): Question[] {
	const byId = new Map(reSolved.map((question) => [question.id, question]));
	// The stem fallback (for verifiers that renumber ids) only trusts stems
	// that appear exactly once in the re-solve — a duplicated stem is ambiguous.
	const byText = new Map<string, Question | null>();
	for (const question of reSolved) {
		const key = verificationTextKey(question.questionText);
		byText.set(key, byText.has(key) ? null : question);
	}
	const contested = new Set<string>();
	for (const original of questions) {
		const match = byId.get(original.id)
			?? byText.get(verificationTextKey(original.questionText));
		if (!match || !match.correctAnswer) continue;
		if (!checkAnswer(original, match.correctAnswer)) contested.add(original.id);
	}
	if (contested.size === 0) return questions;
	if (contested.size > Math.max(1, Math.floor(questions.length / 2))) {
		console.warn(
			`Adaptive Practice: answer verification contested ${contested.size}/${questions.length} questions; distrusting the verification run and keeping the batch.`
		);
		return questions;
	}
	console.warn(
		`Adaptive Practice: dropped ${contested.size} question(s) whose marked answer failed blind re-solving.`
	);
	return questions.filter((question) => !contested.has(question.id));
}

function verificationTextKey(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

async function generateUnverifiedQuestions(
	client: LlmClient,
	prompt: StructuredPrompt,
	config: SessionConfig,
	topicContexts: TopicContext[]
): Promise<Question[]> {
	try {
		const generatedFirstBatch = await requestReconciledQuestions(
			client,
			prompt,
			config.topics,
			topicContexts
		);
		let firstBatch = mergeQuestionBatches(
			[],
			generatedFirstBatch,
			generatedFirstBatch.length
		);
		if (firstBatch.length >= config.questionCount) {
			firstBatch = await repairChallengeIfNeeded(
				client,
				prompt,
				firstBatch,
				config,
				topicContexts
			);
			return ensureChallengeAcceptable(
				prepareGeneratedQuestionsForSession(firstBatch, config),
				config
			);
		}

		const topUpPrompt = buildQuestionTopUpPrompt(
			prompt,
			firstBatch,
			config.questionCount
		);
		let toppedUp: Question[];
		try {
			toppedUp = selectFlowBalancedQuestions(
				firstBatch,
				await requestReconciledQuestions(
					client,
					topUpPrompt,
					config.topics,
					topicContexts
				),
				config.questionCount,
				config.topics,
				config.challengeMode
			);
		} catch (topUpError) {
			if (firstBatch.length > 0) {
				return ensureChallengeAcceptable(
					await repairChallengeIfNeeded(
						client,
						prompt,
						prepareGeneratedQuestionsForSession(firstBatch, config),
						config,
						topicContexts
					),
					config
				);
			}
			throw topUpError;
		}
		return ensureChallengeAcceptable(
			await repairChallengeIfNeeded(
				client,
				prompt,
				toppedUp,
				config,
				topicContexts
			),
			config
		);
	} catch (e) {
		const isParseError =
			e instanceof SyntaxError ||
			(e instanceof Error &&
				/eof|unexpected token|json/i.test(e.message));

		if (!isParseError) {
			throw new Error(
				`Failed to generate questions: ${
					e instanceof Error ? e.message : String(e)
				}`
			);
		}

		try {
			const recovered = prepareGeneratedQuestionsForSession(
				await requestReconciledQuestions(
					client,
					buildQuestionTopUpPrompt(prompt, [], config.questionCount),
					config.topics,
					topicContexts
				),
				config
			);
			return ensureChallengeAcceptable(
				await repairChallengeIfNeeded(
					client,
					prompt,
					recovered,
					config,
					topicContexts
				),
				config
			);
		} catch (retryError) {
			throw new Error(
				`Failed to generate questions after retry: ${
					retryError instanceof Error
						? retryError.message
						: String(retryError)
				}`
			);
		}
	}
}

async function repairChallengeIfNeeded(
	client: LlmClient,
	basePrompt: StructuredPrompt,
	current: Question[],
	config: SessionConfig,
	topicContexts: TopicContext[]
): Promise<Question[]> {
	let batch = selectFlowBalancedQuestions(
		current,
		[],
		config.questionCount,
		config.topics,
		config.challengeMode
	);
	const strict = isStrictChallengeSession(config.topics, config.challengeMode);
	const maxAttempts = strict ? 2 : 1;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (!needsChallengeRepair(batch, config)) break;
		try {
			batch = selectFlowBalancedQuestions(
				batch,
				await requestReconciledQuestions(
					client,
					buildChallengeTopUpPrompt(
						basePrompt,
						batch,
						config.questionCount
					),
					config.topics,
					topicContexts
				),
				config.questionCount,
				config.topics,
				config.challengeMode
			);
		} catch {
			if (strict) {
				throw new Error(
					"Failed to generate enough challenging questions for the current high-skill note."
				);
			}
			return selectFlowBalancedQuestions(
				batch,
				[],
				config.questionCount,
				config.topics,
				config.challengeMode
			);
		}
	}
	return batch;
}

function needsChallengeRepair(
	questions: Question[],
	config: Pick<SessionConfig, "questionCount" | "topics" | "challengeMode">
): boolean {
	return !!challengeShortfallMessage(
		questions,
		config.topics,
		config.challengeMode,
		config.questionCount
	) || shouldRequestChallengeTopUp(
		questions,
		config.topics,
		config.challengeMode
	);
}

function ensureChallengeAcceptable(
	questions: Question[],
	config: Pick<SessionConfig, "questionCount" | "topics" | "challengeMode">
): Question[] {
	const message = challengeShortfallMessage(
		questions,
		config.topics,
		config.challengeMode,
		config.questionCount
	);
	if (message) throw new Error(message);
	return questions;
}

async function requestReconciledQuestions(
	client: LlmClient,
	prompt: StructuredPrompt,
	topics: TopicNote[],
	topicContexts: TopicContext[]
): Promise<Question[]> {
	return calibrateQuestionsForPractice(
		reconcileGeneratedQuestions(
			await client.generateQuestions(prompt),
			topics
		),
		topicContexts,
		topics
	);
}
