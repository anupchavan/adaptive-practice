import { requestUrl } from "obsidian";
import { Question } from "../types";
import { StructuredPrompt } from "./prompt";
import { parseQuestions } from "./parse";
import {
	extractProviderErrorDetail,
	formatProviderError,
	isStructuredOutputRejection,
} from "./errors";
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

		const attempt = await this.requestOnce(prompt, this.config);
		if (attempt.ok) return parseQuestions(attempt.text);

		// Degrade once to plain JSON mode when the strict schema itself is
		// rejected; the prompt already demands JSON output.
		if (
			this.config.jsonMode === "json_schema" &&
			isStructuredOutputRejection(attempt.status, attempt.detail)
		) {
			const fallback = await this.requestOnce(prompt, {
				...this.config,
				jsonMode: "json_object",
			});
			if (fallback.ok) return parseQuestions(fallback.text);
			throw new Error(this.describeFailure(fallback));
		}

		throw new Error(this.describeFailure(attempt));
	}

	private async requestOnce(
		prompt: StructuredPrompt,
		config: OpenAiResponsesConfig
	): Promise<{ ok: boolean; status: number; text: string; detail?: string }> {
		const response = await requestUrl({
			url: normalizeOpenAiResponsesUrl(config.baseUrl),
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(buildOpenAiResponsesBody(prompt, config)),
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
		return { ok: true, status: response.status, text: getOpenAiResponsesText(response.json) };
	}

	private describeFailure(attempt: { status: number; detail?: string }): string {
		return formatProviderError({
			providerLabel: "OpenAI",
			status: attempt.status,
			model: this.config.model,
			baseUrl: normalizeOpenAiResponsesUrl(this.config.baseUrl),
			detail: attempt.detail,
		});
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
