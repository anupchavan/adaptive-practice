import { requestUrl } from "obsidian";
import { Question } from "../types";
import { StructuredPrompt } from "./prompt";
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
		const parts: Array<Record<string, unknown>> = [
			{ text: prompt.textPrompt },
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
			generationConfig: {
				temperature: 0.8,
				maxOutputTokens: 8192,
				responseMimeType: "application/json",
			},
		};
		const bodyStr = JSON.stringify(body);
		const model = normalizeGeminiModel(this.config.model);

		const response = await requestUrl({
			url: `${GEMINI_API_ROOT}/${encodeURIComponent(model)}:generateContent?key=${this.apiKey}`,
			method: "POST",
			headers: { "Content-Type": "application/json" },
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

		return parseQuestions(text);
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
	const firstPart: unknown = parts[0];
	if (!isRecord(firstPart) || typeof firstPart["text"] !== "string") return "";
	return firstPart["text"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}
