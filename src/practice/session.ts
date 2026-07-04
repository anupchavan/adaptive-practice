import { App } from "obsidian";
import {
	AdaptivePracticeSettings,
	LlmProvider,
	LLM_PROVIDER_LABELS,
	OPENAI_COMPATIBLE_PROVIDERS,
	PROVIDER_PRESETS,
	Question,
	QuizResult,
	SessionConfig,
	SkillDelta,
	TopicNote,
} from "../types";
import {
	getNoteContent,
	getNoteStructure,
	getPastHistory,
	getPdfContent,
	getPromptAttachments,
} from "../notes/reader";
import { updateSkill } from "../notes/writer";
import { buildPrompt, TopicContext } from "../llm/prompt";
import { GeminiClient } from "../llm/gemini";
import { AnthropicClient } from "../llm/anthropic";
import { OpenAiCompatibleClient } from "../llm/openai-compatible";
import { OpenAiResponsesClient } from "../llm/openai-responses";
import { computeSkillDeltas } from "./grader";
import { getProviderAttachmentSupport } from "./provider-capabilities";
import { generateQuestionsFromClient } from "./generation-loop";
import type { LlmClient } from "./generation-loop";
import {
	FlowSessionGenerator,
	planUpfrontBatches,
	UPFRONT_CHUNK_SIZE,
} from "./flow-engine";
import { prepareGeneratedQuestionsForSession } from "./flow-calibration";

function createClient(
	provider: LlmProvider,
	apiKey: string,
	settings: AdaptivePracticeSettings
): LlmClient {
	switch (provider) {
		case "anthropic": {
			const preset = PROVIDER_PRESETS[provider];
			return new AnthropicClient(apiKey, {
				model: settings.providerModels[provider] || preset.model,
			});
		}
		case "gemini": {
			const preset = PROVIDER_PRESETS[provider];
			return new GeminiClient(apiKey, {
				model: settings.providerModels[provider] || preset.model,
			});
		}
		case "openai": {
			const preset = PROVIDER_PRESETS[provider];
			return new OpenAiResponsesClient(apiKey, {
				baseUrl: settings.providerBaseUrls[provider] || preset.baseUrl,
				model: settings.providerModels[provider] || preset.model,
				jsonMode: settings.providerJsonModes[provider] || preset.jsonMode,
				supportsImages:
					settings.providerSupportsImages[provider] ?? preset.supportsImages,
			});
		}
		case "deepseek":
		case "qwen":
		case "openrouter":
		case "openai-compatible": {
			const preset = PROVIDER_PRESETS[provider];
			return new OpenAiCompatibleClient(apiKey, {
				baseUrl: settings.providerBaseUrls[provider] || preset.baseUrl,
				model: settings.providerModels[provider] || preset.model,
				jsonMode: settings.providerJsonModes[provider] || preset.jsonMode,
				supportsImages:
					settings.providerSupportsImages[provider] ?? preset.supportsImages,
				providerLabel: LLM_PROVIDER_LABELS[provider],
			});
		}
		default:
			throw new Error("Unsupported model provider.");
	}
}

function assertModelConfigured(
	provider: LlmProvider,
	settings: AdaptivePracticeSettings
): void {
	if (
		(provider === "gemini" || provider === "anthropic" || OPENAI_COMPATIBLE_PROVIDERS.includes(provider)) &&
		!(settings.providerModels[provider] || PROVIDER_PRESETS[provider].model)
	) {
		throw new Error("Choose a model before starting practice.");
	}
}

/**
 * Create a just-in-time flow generator for a session: same contexts, client,
 * and calibration machinery as single-shot generation, but questions arrive
 * in adaptive micro-batches (see flow-engine).
 */
export async function createFlowSessionGenerator(
	app: App,
	apiKey: string,
	config: SessionConfig,
	provider: LlmProvider,
	settings: AdaptivePracticeSettings,
	batchPlan?: number[]
): Promise<FlowSessionGenerator> {
	assertModelConfigured(provider, settings);
	const topicContexts = await buildSessionTopicContexts(app, config, provider, settings);
	const client = createClient(provider, apiKey, settings);
	return new FlowSessionGenerator(client, topicContexts, config, {
		challengeMode: config.challengeMode,
		challengeReason: config.challengeReason,
		intent: settings.practiceIntent,
		questionFeedback: settings.practiceMemory.questionFeedback ?? [],
	}, batchPlan);
}

export async function generateQuestions(
	app: App,
	apiKey: string,
	config: SessionConfig,
	provider: LlmProvider,
	settings: AdaptivePracticeSettings
): Promise<Question[]> {
	assertModelConfigured(provider, settings);

	// No provider reliably fits more than ~8 reason-rich questions inside the
	// shared 8192-token output ceiling, so large up-front sessions generate in
	// balanced chunks and merge — same request shape, never a truncation.
	if (config.questionCount > UPFRONT_CHUNK_SIZE) {
		const generator = await createFlowSessionGenerator(
			app,
			apiKey,
			config,
			provider,
			settings,
			planUpfrontBatches(config.questionCount)
		);
		const all: Question[] = [];
		let batch = await generator.firstBatch();
		while (batch.length > 0) {
			all.push(...batch);
			if (generator.exhausted) break;
			batch = await generator.nextBatch([], all);
		}
		return prepareGeneratedQuestionsForSession(all, config);
	}

	const topicContexts = await buildSessionTopicContexts(app, config, provider, settings);
	const prompt = buildPrompt(topicContexts, config.questionCount, {
		challengeMode: config.challengeMode,
		challengeReason: config.challengeReason,
		questionFeedback: settings.practiceMemory.questionFeedback ?? [],
		intent: settings.practiceIntent,
		now: Date.now(),
	});
	const client = createClient(provider, apiKey, settings);

	return generateQuestionsFromClient(client, prompt, config, topicContexts);
}

async function buildSessionTopicContexts(
	app: App,
	config: SessionConfig,
	provider: LlmProvider,
	settings: AdaptivePracticeSettings
): Promise<TopicContext[]> {
	const attachmentSupport = getProviderAttachmentSupport(provider, settings);
	const topicContexts: TopicContext[] = await Promise.all(
		config.topics.map(async (note) => {
			if (note.isPdf) {
				return {
					note,
					content: "",
					history: "",
					pdfData: await getPdfContent(app, note.path),
				};
			}
			const structure = await getNoteStructure(app, note.path, settings);
			return {
				note,
				content: structure?.cleanedText ?? await getNoteContent(app, note.path),
				history: await getPastHistory(app, note.path),
				practicedSubtopics:
					settings.practiceMemory.notes[note.path]?.practicedSubtopics ?? {},
				structure: structure ?? undefined,
				attachments: structure
					? await getPromptAttachments(
						app,
						structure,
						note.title,
						attachmentSupport
					)
					: [],
			};
		})
	);

	shuffle(topicContexts);
	return topicContexts;
}

export async function finalizeSession(
	app: App,
	topics: TopicNote[],
	results: QuizResult[],
	savePdfSkill?: (path: string, skill: number) => Promise<void>
): Promise<SkillDelta[]> {
	const deltas = computeSkillDeltas(topics, results);

	for (const delta of deltas) {
		await updateSkill(app, delta.path, delta.after, savePdfSkill);
	}

	return deltas;
}

function shuffle<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j]!, arr[i]!];
	}
}
