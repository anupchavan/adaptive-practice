import { requestUrl } from "obsidian";
import { Question } from "../types";
import { StructuredPrompt } from "./prompt";
import { parseQuestions } from "./parse";
import { extractProviderErrorDetail, formatProviderError } from "./errors";
import {
	buildOpenAiResponsesBody,
	getOpenAiResponsesText,
	normalizeOpenAiResponsesUrl,
	OpenAiResponsesConfig,
} from "./openai-responses-format";

export class OpenAiResponsesClient {
	private apiKey: string;
	private config: OpenAiResponsesConfig;

	constructor(apiKey: string, config: OpenAiResponsesConfig) {
		this.apiKey = apiKey;
		this.config = config;
	}

	async generateQuestions(prompt: StructuredPrompt): Promise<Question[]> {
		const pdfAttachments = prompt.attachments.filter((attachment) => attachment.kind === "pdf");
		if (pdfAttachments.length > 0) {
			throw new Error(
				"OpenAI cannot receive PDF attachments through this adapter yet. Use Gemini or Anthropic for PDF-first sessions."
			);
		}

		const endpoint = normalizeOpenAiResponsesUrl(this.config.baseUrl);
		const response = await requestUrl({
			url: endpoint,
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(buildOpenAiResponsesBody(prompt, this.config)),
			throw: false,
		});

		if (response.status < 200 || response.status >= 300) {
			throw new Error(formatProviderError({
				providerLabel: "OpenAI",
				status: response.status,
				model: this.config.model,
				baseUrl: endpoint,
				detail: extractProviderErrorDetail(response.text),
			}));
		}

		return parseQuestions(getOpenAiResponsesText(response.json));
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
}
