import { requestUrl } from "obsidian";
import { Question } from "../types";
import { GENERATION_TEMPERATURE, resolvePromptParts, StructuredPrompt } from "./prompt";
import { parseQuestions } from "./parse";
import { extractProviderErrorDetail, formatProviderError } from "./errors";

const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiClientConfig {
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

export class GeminiClient {
	private apiKey: string;
	private config: GeminiClientConfig;

	constructor(apiKey: string, config: GeminiClientConfig) {
		this.apiKey = apiKey;
		this.config = config;
	}

	async generateQuestions(prompt: StructuredPrompt): Promise<Question[]> {
		const { system, user } = resolvePromptParts(prompt);
		const parts: Array<Record<string, unknown>> = [
			{ text: user },
		];

		for (const attachment of prompt.attachments) {
			parts.push({
				inline_data: {
					mime_type: attachment.mimeType,
					data: arrayBufferToBase64(attachment.data),
				},
			});
		}

		const body = {
			contents: [{ parts }],
			systemInstruction: { parts: [{ text: system }] },
			generationConfig: {
				temperature: GENERATION_TEMPERATURE,
				maxOutputTokens: 8192,
				responseMimeType: "application/json",
			},
		};
		const bodyStr = JSON.stringify(body);
		const model = normalizeGeminiModel(this.config.model);

		const response = await requestUrl({
			// Send the key as a header, not a ?key= query parameter, so it does not
			// leak into URL logs, error reports, or network diagnostics.
			url: `${GEMINI_API_ROOT}/${encodeURIComponent(model)}:generateContent`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-goog-api-key": this.apiKey,
			},
			body: bodyStr,
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(formatProviderError({
				providerLabel: "Gemini",
				status: response.status,
				model,
				detail: extractProviderErrorDetail(response.text),
			}));
		}

		const data: unknown = response.json;
		const text = getGeminiText(data);

		try {
			return parseQuestions(text);
		} catch (error) {
			if (geminiResponseTruncated(data)) {
				throw new Error(
					"Gemini stopped before finishing the questions (hit the output token limit). Try generating fewer questions per session."
				);
			}
			throw error;
		}
	}
}

function normalizeGeminiModel(model: string): string {
	return model.trim().replace(/^models\//, "");
}

function getGeminiText(data: unknown): string {
	if (!isRecord(data)) return "";
	const candidates = data["candidates"];
	if (!Array.isArray(candidates)) return "";
	const candidate: unknown = candidates[0];
	if (!isRecord(candidate)) return "";
	const content = candidate["content"];
	if (!isRecord(content)) return "";
	const parts = content["parts"];
	if (!Array.isArray(parts)) return "";
	// Concatenate every answer part, skipping reasoning/"thought" parts. Gemini
	// can split output across multiple parts, so reading parts[0] alone risks
	// returning a reasoning fragment or an empty string on a successful response.
	let text = "";
	for (const part of parts) {
		if (!isRecord(part) || part["thought"] === true) continue;
		if (typeof part["text"] === "string") text += part["text"];
	}
	return text;
}

function geminiResponseTruncated(data: unknown): boolean {
	if (!isRecord(data)) return false;
	const candidates = data["candidates"];
	if (!Array.isArray(candidates)) return false;
	const candidate: unknown = candidates[0];
	if (!isRecord(candidate)) return false;
	return candidate["finishReason"] === "MAX_TOKENS";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}
