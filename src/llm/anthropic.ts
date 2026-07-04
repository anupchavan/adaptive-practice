import { requestUrl } from "obsidian";
import { Question } from "../types";
import { GENERATION_TEMPERATURE, resolvePromptParts, StructuredPrompt } from "./prompt";
import { parseQuestions } from "./parse";
import {
	extractProviderErrorDetail,
	formatProviderError,
	isSamplingParamRejection,
	isThinkingConfigRejection,
} from "./errors";
import { modelHasAlwaysOnThinking, modelOmitsSamplingParams } from "./openai-shared";

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

		// Sonnet 5 / Opus 4.7+ / Fable removed sampling parameters entirely —
		// sending temperature 400s. Known models skip it up front; unknown
		// future models self-heal via the sampling-rejection retry below.
		let withTemperature = !modelOmitsSamplingParams(this.config.model);
		// Newer Claude models (Sonnet 5+) run adaptive thinking BY DEFAULT when
		// the `thinking` field is omitted, and thinking tokens count against
		// max_tokens — so thinking silently eats the budget and the question
		// JSON truncates mid-array. The schema already forces reasoning before
		// answering (explanation precedes correctAnswer), so thinking is
		// explicitly disabled here. Fable/Mythos-family models reject
		// "disabled" (thinking is always on); they get max_tokens headroom
		// instead, and unknown models self-heal via the rejection retry.
		let withThinkingDisabled = !modelHasAlwaysOnThinking(this.config.model);
		let response = await this.requestMessages(system, content, prompt, {
			withTemperature,
			withThinkingDisabled,
		});
		if (
			response.status !== 200 &&
			withThinkingDisabled &&
			isThinkingConfigRejection(
				response.status,
				extractProviderErrorDetail(response.text)
			)
		) {
			withThinkingDisabled = false;
			response = await this.requestMessages(system, content, prompt, {
				withTemperature,
				withThinkingDisabled,
			});
		}
		if (
			response.status !== 200 &&
			withTemperature &&
			isSamplingParamRejection(
				response.status,
				extractProviderErrorDetail(response.text)
			)
		) {
			withTemperature = false;
			response = await this.requestMessages(system, content, prompt, {
				withTemperature,
				withThinkingDisabled,
			});
		}

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

	private async requestMessages(
		system: string,
		content: Array<Record<string, unknown>>,
		prompt: StructuredPrompt,
		options: { withTemperature: boolean; withThinkingDisabled: boolean }
	): Promise<{ status: number; text: string; json: unknown }> {
		// max_tokens is a cap, not a spend — Anthropic bills actual output —
		// so floor it at 8192 for slack on long questions. Requests that run
		// with thinking on (always-on models, or a retry that dropped the
		// disable flag) share that cap with thinking tokens and need more.
		const maxTokens = Math.max(
			prompt.maxOutputTokens ?? 8192,
			options.withThinkingDisabled ? 8192 : 16384
		);
		const body = {
			model: this.config.model,
			max_tokens: maxTokens,
			...(options.withTemperature ? { temperature: GENERATION_TEMPERATURE } : {}),
			...(options.withThinkingDisabled ? { thinking: { type: "disabled" } } : {}),
			// The system prompt is identical across sessions (and across the
			// micro-batches of one session), so mark it as a cache breakpoint —
			// repeat requests within the cache TTL read it at ~10% input price.
			system: [
				{
					type: "text",
					text: system,
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [
				{
					role: "user",
					content,
				},
			],
		};

		return requestUrl({
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
