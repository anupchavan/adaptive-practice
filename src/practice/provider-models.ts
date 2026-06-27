import {
	AdaptivePracticeSettings,
	LlmProvider,
	LLM_PROVIDER_LABELS,
	PROVIDER_PRESETS,
} from "../types";

const LEGACY_PROVIDER_MODELS: Partial<Record<LlmProvider, Record<string, string>>> = {
	anthropic: {
		"claude-sonnet-4-20250514": PROVIDER_PRESETS.anthropic.model,
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
			setProviderModelOverride(output, provider, value);
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

export function setProviderModelOverride(
	models: AdaptivePracticeSettings["providerModels"],
	provider: LlmProvider,
	model: string
): void {
	const migrated = migrateProviderModel(provider, model);
	if (!migrated || migrated === PROVIDER_PRESETS[provider].model) {
		delete models[provider];
		return;
	}
	models[provider] = migrated;
}

export function providerModelsNeedNormalization(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const rawEntries = Object.entries(input as Record<string, unknown>)
		.filter(([key, value]) => key in LLM_PROVIDER_LABELS && typeof value === "string")
		.map(([key, value]) => [key, (value as string).trim()] as const);
	const normalized = normalizeProviderModels(input);
	const normalizedEntries = Object.entries(normalized)
		.map(([key, value]) => [key, value] as const);
	if (rawEntries.length !== normalizedEntries.length) return true;
	for (const [key, value] of rawEntries) {
		const provider = key as LlmProvider;
		if (normalized[provider] !== value) return true;
	}
	return false;
}
