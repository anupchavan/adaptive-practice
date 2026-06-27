import {
	AdaptivePracticeSettings,
	LLM_PROVIDER_LABELS,
	LlmProvider,
	PROVIDER_PRESETS,
	TopicNote,
} from "../types";

export interface ProviderTopicCompatibility {
	compatibleTopics: TopicNote[];
	skippedPdfTopics: TopicNote[];
	warning: string;
}

export interface ProviderAttachmentSupport {
	includeImages: boolean;
	includePdfs: boolean;
}

type ProviderAttachmentSettings = Pick<
	AdaptivePracticeSettings,
	"providerSupportsImages"
>;

export function getProviderAttachmentSupport(
	provider: LlmProvider,
	settings: ProviderAttachmentSettings
): ProviderAttachmentSupport {
	const preset = PROVIDER_PRESETS[provider];
	return {
		includeImages:
			settings.providerSupportsImages[provider] ?? preset.supportsImages,
		includePdfs: preset.supportsPdfs,
	};
}

export function splitProviderCompatibleTopics(
	provider: LlmProvider,
	topics: TopicNote[]
): ProviderTopicCompatibility {
	if (PROVIDER_PRESETS[provider].supportsPdfs) {
		return {
			compatibleTopics: topics,
			skippedPdfTopics: [],
			warning: "",
		};
	}

	const compatibleTopics = topics.filter((topic) => !topic.isPdf);
	const skippedPdfTopics = topics.filter((topic) => topic.isPdf);
	return {
		compatibleTopics,
		skippedPdfTopics,
		warning: getProviderPdfWarning(provider, skippedPdfTopics),
	};
}

export function dailyTopicCandidateLimitForProvider(
	provider: LlmProvider,
	totalTopics: number,
	dailyTopicLimit: number
): number {
	const safeDailyLimit = Math.max(1, dailyTopicLimit);
	if (PROVIDER_PRESETS[provider].supportsPdfs) {
		return Math.min(totalTopics, safeDailyLimit);
	}
	return totalTopics;
}

export function getProviderPdfWarning(
	provider: LlmProvider,
	topics: TopicNote[]
): string {
	const pdfCount = topics.filter((topic) => topic.isPdf).length;
	if (pdfCount === 0 || PROVIDER_PRESETS[provider].supportsPdfs) return "";
	const label = LLM_PROVIDER_LABELS[provider];
	return `${label} cannot read PDF topic attachments in Adaptive Practice yet. Switch to Gemini or Anthropic, or choose non-PDF notes.`;
}
