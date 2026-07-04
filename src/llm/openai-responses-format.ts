import { GENERATION_TEMPERATURE, resolvePromptParts, StructuredPrompt } from "./prompt";
import {
	arrayBufferToBase64,
	CompatibleJsonMode,
	MAX_OUTPUT_TOKENS,
	questionSchema,
} from "./openai-shared";

export interface OpenAiResponsesConfig {
	baseUrl: string;
	model: string;
	jsonMode: CompatibleJsonMode;
	supportsImages: boolean;
}

export function buildOpenAiResponsesBody(
	prompt: StructuredPrompt,
	config: OpenAiResponsesConfig
): Record<string, unknown> {
	const { system, user } = resolvePromptParts(prompt);
	const imageAttachments = prompt.attachments.filter((attachment) => attachment.kind === "image");
	const body: Record<string, unknown> = {
		model: config.model,
		instructions: system,
		input: [
			{
				role: "user",
				content: buildResponsesContent(user, imageAttachments, config),
			},
		],
		max_output_tokens: prompt.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
		store: false,
	};
	if (supportsCustomTemperature(config.model)) {
		body["temperature"] = GENERATION_TEMPERATURE;
	}

	const textFormat = responseTextFormat(config.jsonMode);
	if (textFormat) {
		body["text"] = { format: textFormat };
	}
	return body;
}

function supportsCustomTemperature(model: string): boolean {
	return !/^gpt-5(?:[.-]|$)/i.test(model.trim());
}

export function normalizeOpenAiResponsesUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim().replace(/\/+$/, "");
	if (!trimmed) return "https://api.openai.com/v1/responses";
	if (/\/responses$/i.test(trimmed)) return trimmed;
	if (/\/chat\/completions$/i.test(trimmed)) {
		return trimmed.replace(/\/chat\/completions$/i, "/responses");
	}
	if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/responses`;
	return `${trimmed}/responses`;
}

export function getOpenAiResponsesText(data: unknown): string {
	if (!isRecord(data)) return "";
	if (typeof data["output_text"] === "string") return data["output_text"];

	const output = data["output"];
	if (!Array.isArray(output)) return "";
	const parts: string[] = [];
	for (const item of output) {
		if (!isRecord(item)) continue;
		const content = item["content"];
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!isRecord(block)) continue;
			const text = block["text"];
			if (
				(block["type"] === "output_text" || block["type"] === "text") &&
				typeof text === "string"
			) {
				parts.push(text);
			}
		}
	}
	return parts.join("\n");
}

function buildResponsesContent(
	textPrompt: string,
	imageAttachments: StructuredPrompt["attachments"],
	config: OpenAiResponsesConfig
): string | Array<Record<string, unknown>> {
	if (!config.supportsImages || imageAttachments.length === 0) {
		if (imageAttachments.length === 0) return textPrompt;
		return `${textPrompt}\n\nProvider note: OpenAI is configured as text-only, so image binaries were not attached. Use any SVG source or media descriptions included in the note context.`;
	}

	const content: Array<Record<string, unknown>> = [
		{
			type: "input_text",
			text: textPrompt,
		},
	];
	for (const attachment of imageAttachments) {
		content.push({
			type: "input_image",
			image_url: `data:${attachment.mimeType};base64,${arrayBufferToBase64(attachment.data)}`,
		});
	}
	return content;
}

function responseTextFormat(mode: CompatibleJsonMode): Record<string, unknown> | null {
	if (mode === "json_object") return { type: "json_object" };
	if (mode === "json_schema") {
		return {
			type: "json_schema",
			name: "adaptive_practice_questions",
			strict: true,
			schema: questionSchema(),
		};
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}
