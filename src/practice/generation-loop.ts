import { StructuredPrompt, TopicContext } from "../llm/prompt";
import { Question, SessionConfig, TopicNote } from "../types";
import { reconcileGeneratedQuestions } from "./source-map";
import {
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
