import {
	AdaptivePracticeSettings,
	LlmProvider,
	LLM_PROVIDER_LABELS,
	PROVIDER_PRESETS,
} from "../types";

const LEGACY_PROVIDER_MODELS: Partial<Record<LlmProvider, Record<string, string>>> = {
	gemini: {
		"gemini-2.0-flash": PROVIDER_PRESETS.gemini.model,
	},
	anthropic: {
		"claude-sonnet-4-20250514": PROVIDER_PRESETS.anthropic.model,
	},
	deepseek: {
		"deepseek-chat": PROVIDER_PRESETS.deepseek.model,
		"deepseek-reasoner": PROVIDER_PRESETS.deepseek.model,
	},
	qwen: {
		"qwen-plus": PROVIDER_PRESETS.qwen.model,
	},
	openrouter: {
		"openai/gpt-4o-mini": PROVIDER_PRESETS.openrouter.model,
	},
};

export function normalizeProviderModels(
	input: unknown
): AdaptivePracticeSettings["providerModels"] {
	if (!input || typeof input !== "object") return {};
	const output: AdaptivePracticeSettings["providerModels"] = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (key in LLM_PROVIDER_LABELS && typeof value === "string") {
			const provider = key as LlmProvider;
			output[provider] = migrateProviderModel(provider, value);
		}
	}
	return output;
}

export function migrateProviderModel(
	provider: LlmProvider,
	model: string
): string {
	const trimmed = model.trim();
	if (!trimmed) return trimmed;
	return LEGACY_PROVIDER_MODELS[provider]?.[trimmed] ?? trimmed;
}

export function hasStaleProviderModels(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (!(key in LLM_PROVIDER_LABELS) || typeof value !== "string") continue;
		const provider = key as LlmProvider;
		if (migrateProviderModel(provider, value) !== value.trim()) return true;
	}
	return false;
}
