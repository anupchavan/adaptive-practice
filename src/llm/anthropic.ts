import { requestUrl } from "obsidian";
import { Question } from "../types";
import { GENERATION_TEMPERATURE, resolvePromptParts, StructuredPrompt } from "./prompt";
import { parseQuestions } from "./parse";
import { extractProviderErrorDetail, formatProviderError } from "./errors";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export interface AnthropicClientConfig {
	model: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

export class AnthropicClient {
	private apiKey: string;
	private config: AnthropicClientConfig;

	constructor(apiKey: string, config: AnthropicClientConfig) {
		this.apiKey = apiKey;
		this.config = config;
	}

	async generateQuestions(prompt: StructuredPrompt): Promise<Question[]> {
		const { system, user } = resolvePromptParts(prompt);
		const content: Array<Record<string, unknown>> = [];

		for (const attachment of prompt.attachments) {
			if (attachment.kind === "pdf") {
				content.push({
					type: "document",
					source: {
						type: "base64",
						media_type: attachment.mimeType,
						data: arrayBufferToBase64(attachment.data),
					},
				});
			} else {
				content.push({
					type: "image",
					source: {
						type: "base64",
						media_type: attachment.mimeType,
						data: arrayBufferToBase64(attachment.data),
					},
				});
			}
		}

		content.push({
			type: "text",
			text: user,
		});

		const body = {
			model: this.config.model,
			max_tokens: 8192,
			temperature: GENERATION_TEMPERATURE,
			system,
			messages: [
				{
					role: "user",
					content,
				},
			],
		};

		const response = await requestUrl({
			url: ANTHROPIC_URL,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(formatProviderError({
				providerLabel: "Anthropic",
				status: response.status,
				model: this.config.model,
				detail: extractProviderErrorDetail(response.text),
			}));
		}

		const data: unknown = response.json;
		const text = getAnthropicText(data);

		try {
			return parseQuestions(text);
		} catch (error) {
			if (anthropicResponseTruncated(data)) {
				throw new Error(
					"Anthropic stopped before finishing the questions (hit the output token limit). Try generating fewer questions per session."
				);
			}
			throw error;
		}
	}
}

function getAnthropicText(data: unknown): string {
	if (!isRecord(data) || !Array.isArray(data["content"])) return "";
	// Join every text block. A response may contain multiple text blocks (or be
	// preceded by a thinking block), so returning only the first risks dropping
	// part of the JSON payload.
	let text = "";
	for (const block of data["content"]) {
		if (!isRecord(block)) continue;
		if (block["type"] === "text" && typeof block["text"] === "string") {
			text += block["text"];
		}
	}
	return text;
}

function anthropicResponseTruncated(data: unknown): boolean {
	return isRecord(data) && data["stop_reason"] === "max_tokens";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}
