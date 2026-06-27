import { requestUrl } from "obsidian";
import { Question } from "../types";
import { StructuredPrompt } from "./prompt";
import { parseQuestions } from "./parse";
import { extractProviderErrorDetail, formatProviderError } from "./errors";

export type CompatibleJsonMode = "json_schema" | "json_object" | "prompt_only";

export interface OpenAiCompatibleConfig {
	baseUrl: string;
	model: string;
	jsonMode: CompatibleJsonMode;
	supportsImages: boolean;
	providerLabel: string;
}

const MAX_OUTPUT_TOKENS = 8192;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
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

		const imageAttachments = prompt.attachments.filter((attachment) => attachment.kind === "image");
		const content = this.buildMessageContent(prompt.textPrompt, imageAttachments);
		const body = {
			model: this.config.model,
			messages: [
				{
					role: "system",
					content: "You generate Adaptive Practice questions. Return only valid JSON.",
				},
				{
					role: "user",
					content,
				},
			],
			temperature: 0.7,
			max_tokens: MAX_OUTPUT_TOKENS,
			...this.responseFormat(),
		};

		const endpoint = normalizeChatCompletionsUrl(this.config.baseUrl);
		const response = await requestUrl({
			url: endpoint,
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(body),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(formatProviderError({
				providerLabel: this.config.providerLabel,
				status: response.status,
				model: this.config.model,
				baseUrl: endpoint,
				detail: extractProviderErrorDetail(response.text),
			}));
		}

		const text = getChatCompletionText(response.json);
		return parseQuestions(text);
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

	private responseFormat(): Record<string, unknown> {
		if (this.config.jsonMode === "json_object") {
			return { response_format: { type: "json_object" } };
		}
		if (this.config.jsonMode === "json_schema") {
			return {
				response_format: {
					type: "json_schema",
					json_schema: {
						name: "adaptive_practice_questions",
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

function questionSchema(): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		required: ["questions"],
		properties: {
			questions: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					additionalProperties: false,
					required: [
						"id",
						"type",
						"questionText",
						"correctAnswer",
						"explanation",
						"sourceTopics",
						"sourceSubtopics",
						"difficulty",
					],
					properties: {
						id: { type: "string" },
						type: { type: "string", enum: ["mcq", "integer", "decimal"] },
						questionText: { type: "string" },
						options: {
							type: "array",
							items: { type: "string" },
						},
						correctAnswer: { type: "string" },
						explanation: { type: "string" },
						sourceTopics: {
							type: "array",
							items: { type: "string" },
						},
						sourceSubtopics: {
							type: "array",
							items: { type: "string" },
						},
						difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
					},
				},
			},
		},
	};
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
