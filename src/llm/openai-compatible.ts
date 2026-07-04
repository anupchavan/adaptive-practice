import { requestUrl } from "obsidian";
import { Question } from "../types";
import { GENERATION_TEMPERATURE, resolvePromptParts, StructuredPrompt } from "./prompt";
import { parseQuestions } from "./parse";
import {
	extractProviderErrorDetail,
	formatProviderError,
	isStructuredOutputRejection,
} from "./errors";
import {
	arrayBufferToBase64,
	CompatibleJsonMode,
	MAX_OUTPUT_TOKENS,
	questionSchema,
} from "./openai-shared";

export interface OpenAiCompatibleConfig {
	baseUrl: string;
	model: string;
	jsonMode: CompatibleJsonMode;
	supportsImages: boolean;
	providerLabel: string;
}

export class OpenAiCompatibleClient {
	private apiKey: string;
	private config: OpenAiCompatibleConfig;

	constructor(apiKey: string, config: OpenAiCompatibleConfig) {
		this.apiKey = apiKey;
		this.config = config;
	}

	async generateQuestions(prompt: StructuredPrompt): Promise<Question[]> {
		const pdfAttachments = prompt.attachments.filter((attachment) => attachment.kind === "pdf");
		if (pdfAttachments.length > 0) {
			throw new Error(
				`${this.config.providerLabel} cannot receive PDF attachments through this adapter yet. Use Gemini or Anthropic for PDF-first sessions.`
			);
		}

		const { system, user } = resolvePromptParts(prompt);
		const imageAttachments = prompt.attachments.filter((attachment) => attachment.kind === "image");
		const content = this.buildMessageContent(user, imageAttachments);

		const attempt = await this.requestChatCompletion(system, content, this.config.jsonMode);
		if (attempt.ok) return parseQuestions(attempt.text);

		// Some OpenAI-compatible gateways reject strict json_schema outright.
		// The prompt already demands JSON, so degrade once to plain JSON mode
		// instead of failing the whole session.
		if (
			this.config.jsonMode === "json_schema" &&
			isStructuredOutputRejection(attempt.status, attempt.detail)
		) {
			const fallback = await this.requestChatCompletion(system, content, "json_object");
			if (fallback.ok) return parseQuestions(fallback.text);
			throw new Error(this.describeFailure(fallback));
		}

		throw new Error(this.describeFailure(attempt));
	}

	private async requestChatCompletion(
		system: string,
		content: string | Array<Record<string, unknown>>,
		jsonMode: CompatibleJsonMode
	): Promise<{ ok: boolean; status: number; text: string; detail?: string }> {
		const body = {
			model: this.config.model,
			messages: [
				{
					role: "system",
					content: system,
				},
				{
					role: "user",
					content,
				},
			],
			temperature: GENERATION_TEMPERATURE,
			max_tokens: MAX_OUTPUT_TOKENS,
			...this.responseFormat(jsonMode),
		};

		const response = await requestUrl({
			url: normalizeChatCompletionsUrl(this.config.baseUrl),
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			return {
				ok: false,
				status: response.status,
				text: "",
				detail: extractProviderErrorDetail(response.text),
			};
		}
		return { ok: true, status: response.status, text: getChatCompletionText(response.json) };
	}

	private describeFailure(
		attempt: { status: number; detail?: string }
	): string {
		return formatProviderError({
			providerLabel: this.config.providerLabel,
			status: attempt.status,
			model: this.config.model,
			baseUrl: normalizeChatCompletionsUrl(this.config.baseUrl),
			detail: attempt.detail,
		});
	}

	private buildMessageContent(
		textPrompt: string,
		imageAttachments: StructuredPrompt["attachments"]
	): string | Array<Record<string, unknown>> {
		if (!this.config.supportsImages || imageAttachments.length === 0) {
			if (imageAttachments.length === 0) return textPrompt;
			return `${textPrompt}\n\nProvider note: ${this.config.providerLabel} is configured as text-only, so image binaries were not attached. Use any SVG source or media descriptions included in the note context.`;
		}

		const content: Array<Record<string, unknown>> = [
			{
				type: "text",
				text: textPrompt,
			},
		];

		for (const attachment of imageAttachments) {
			content.push({
				type: "image_url",
				image_url: {
					url: `data:${attachment.mimeType};base64,${arrayBufferToBase64(attachment.data)}`,
				},
			});
		}

		return content;
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.apiKey.trim()) {
			headers["Authorization"] = `Bearer ${this.apiKey.trim()}`;
		}
		return headers;
	}

	private responseFormat(jsonMode: CompatibleJsonMode): Record<string, unknown> {
		if (jsonMode === "json_object") {
			return { response_format: { type: "json_object" } };
		}
		if (jsonMode === "json_schema") {
			return {
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "adaptive_practice_questions",
						strict: true,
						schema: questionSchema(),
					},
				},
			};
		}
		return {};
	}
}

export function normalizeChatCompletionsUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim().replace(/\/+$/, "");
	if (!trimmed) return "http://localhost:1234/v1/chat/completions";
	if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
	if (/\/v\d+$/i.test(trimmed) || /\/compatible-mode\/v\d+$/i.test(trimmed)) {
		return `${trimmed}/chat/completions`;
	}
	return `${trimmed}/chat/completions`;
}

function getChatCompletionText(data: unknown): string {
	if (!isRecord(data)) return "";
	const choices = data["choices"];
	if (!Array.isArray(choices)) return "";
	const firstChoice: unknown = choices[0];
	if (!isRecord(firstChoice)) return "";
	const message = firstChoice["message"];
	if (!isRecord(message)) return "";
	const content = message["content"];
	return typeof content === "string" ? content : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}
