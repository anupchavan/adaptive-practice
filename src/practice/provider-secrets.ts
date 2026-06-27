import {
	AdaptivePracticeSettings,
	DEFAULT_SETTINGS,
	LLM_PROVIDER_LABELS,
	LlmProvider,
	PROVIDER_PRESETS,
} from "../types";

export function normalizeProviderSecretNames(
	input: unknown,
	activeProvider: LlmProvider,
	legacySecretName: unknown
): Partial<Record<LlmProvider, string>> {
	const output = normalizeSecretRecord(input);
	const legacySecret =
		typeof legacySecretName === "string" ? legacySecretName.trim() : "";
	if (!legacySecret || output[activeProvider]) return output;

	const defaultForActive = PROVIDER_PRESETS[activeProvider].secretName;
	const knownDefault = Object.values(PROVIDER_PRESETS).some(
		(preset) => preset.secretName === legacySecret
	);
	if (
		activeProvider === "gemini" ||
		legacySecret === defaultForActive ||
		!knownDefault
	) {
		output[activeProvider] = legacySecret;
	}
	return output;
}

export function getProviderSecretName(
	settings: Pick<
		AdaptivePracticeSettings,
		"llmProvider" | "secretName" | "providerSecretNames"
	>,
	provider: LlmProvider = settings.llmProvider
): string {
	const hasProviderSecrets = Object.keys(settings.providerSecretNames ?? {}).length > 0;
	const legacySecret = settings.secretName.trim();
	const defaultSecret = PROVIDER_PRESETS[provider].secretName;
	const legacyAppliesToProvider =
		!hasProviderSecrets &&
		provider === settings.llmProvider &&
		!!legacySecret &&
		(
			provider === "gemini" ||
			legacySecret === defaultSecret ||
			!isKnownDefaultSecret(legacySecret)
		);
	return (
		settings.providerSecretNames?.[provider]?.trim() ||
		(legacyAppliesToProvider ? legacySecret : "") ||
		defaultSecret
	);
}

export function getProviderSecretId(
	settings: Pick<
		AdaptivePracticeSettings,
		"llmProvider" | "secretName" | "providerSecretNames"
	>
): string {
	const fallback = PROVIDER_PRESETS[settings.llmProvider].secretName;
	return sanitizeSecretId(getProviderSecretName(settings), fallback);
}

export function setProviderSecretName(
	settings: AdaptivePracticeSettings,
	provider: LlmProvider,
	value: string
): void {
	const defaultSecret = PROVIDER_PRESETS[provider].secretName;
	const next = value.trim() || defaultSecret;
	settings.providerSecretNames = {
		...settings.providerSecretNames,
		[provider]: next,
	};
	if (provider === settings.llmProvider) {
		settings.secretName = next;
	}
}

export function syncLegacySecretName(settings: AdaptivePracticeSettings): void {
	settings.secretName = getProviderSecretName(settings);
}

function normalizeSecretRecord(input: unknown): Partial<Record<LlmProvider, string>> {
	if (!input || typeof input !== "object") return {};
	const output: Partial<Record<LlmProvider, string>> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (key in LLM_PROVIDER_LABELS && typeof value === "string" && value.trim()) {
			output[key as LlmProvider] = value.trim();
		}
	}
	return output;
}

function isKnownDefaultSecret(value: string): boolean {
	return Object.values(PROVIDER_PRESETS).some(
		(preset) => preset.secretName === value
	);
}

function sanitizeSecretId(input: string, fallback: string): string {
	const id = input.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
	return id || fallback || DEFAULT_SETTINGS.secretName;
}
