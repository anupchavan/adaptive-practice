import { LlmProvider } from "../types";

/**
 * Curated model choices shown in the settings dropdown, per provider. The
 * preset default is always offered first and a "Custom…" option keeps free
 * text available, so an out-of-date list never blocks anyone — but this DOES
 * need a manual refresh when providers ship new models. Only list models
 * verified to work with this plugin's request shapes.
 */
export const PROVIDER_MODEL_SUGGESTIONS: Partial<Record<LlmProvider, string[]>> = {
	anthropic: [
		"claude-sonnet-4-6",
		"claude-sonnet-5",
		"claude-opus-4-8",
		"claude-haiku-4-5-20251001",
		"claude-fable-5",
	],
	gemini: ["gemini-3.5-flash"],
	openai: ["gpt-5.5"],
	deepseek: ["deepseek-v4-flash"],
	qwen: ["qwen3.7-plus"],
	openrouter: ["openai/gpt-5.4-mini"],
};

export const CUSTOM_MODEL_OPTION = "__custom__";

/** Dropdown options for a provider: default first, then curated, then custom. */
export function modelDropdownOptions(
	provider: LlmProvider,
	presetModel: string
): string[] {
	const curated = PROVIDER_MODEL_SUGGESTIONS[provider] ?? [];
	const seen = new Set<string>();
	const options: string[] = [];
	for (const model of [presetModel, ...curated]) {
		if (!model || seen.has(model)) continue;
		seen.add(model);
		options.push(model);
	}
	return options;
}
