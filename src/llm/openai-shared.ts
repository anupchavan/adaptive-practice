export type CompatibleJsonMode = "json_schema" | "json_object" | "prompt_only";

export const MAX_OUTPUT_TOKENS = 8192;

/**
 * Claude Sonnet 5, Opus 4.7+, and the Fable/Mythos 5 family removed the
 * sampling parameters entirely — a non-default `temperature` returns a 400.
 * Steering on those models is prompt-side (which this plugin already does);
 * older Claude models keep the pinned temperature for output consistency.
 */
export function modelOmitsSamplingParams(model: string): boolean {
	return /claude-(?:sonnet-5|opus-4-[7-9]|fable|mythos)/i.test(model);
}

/**
 * Fable/Mythos-family models think always-on and reject an explicit
 * `thinking: {type: "disabled"}` — for them the thinking field must be
 * omitted and max_tokens needs headroom, because thinking spend counts
 * against it. Every other Claude model gets thinking explicitly disabled
 * for question JSON: newer models (Sonnet 5) run adaptive thinking BY
 * DEFAULT when the field is omitted, silently consuming the output budget
 * and truncating the JSON mid-questions.
 */
export function modelHasAlwaysOnThinking(model: string): boolean {
	return /claude-(?:fable|mythos)/i.test(model);
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary);
}

/**
 * JSON schema for a question batch, shaped to be *strict* structured-output
 * valid: every property is listed in `required`, objects set
 * `additionalProperties: false`, `options` is nullable (so numeric questions
 * can omit it), and unsupported keywords like `minItems` are avoided. Requests
 * send `strict: true`; if a gateway rejects the schema, the client retries
 * once in plain JSON mode (see isStructuredOutputRejection), so a rejection
 * degrades gracefully instead of failing the session.
 */
export function questionSchema(): Record<string, unknown> {
	return {
		type: "object",
		additionalProperties: false,
		required: ["questions"],
		properties: {
			questions: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: [
						"id",
						"type",
						"questionText",
						"options",
						"explanation",
						"correctAnswer",
						"correctAnswers",
						"sourceTopics",
						"sourceSubtopics",
						"difficulty",
					],
					// Property order is deliberate: explanation precedes
					// correctAnswer so schema-ordered generation reasons before
					// committing to an answer (prevents answer-then-rationalize).
					properties: {
						id: { type: "string" },
						type: { type: "string", enum: ["mcq", "multi", "integer", "decimal"] },
						questionText: { type: "string" },
						// Nullable: numeric questions return null, MCQs return strings.
						options: {
							type: ["array", "null"],
							items: { type: "string" },
						},
						explanation: { type: "string" },
						correctAnswer: { type: "string" },
						// Only "multi" (select-all-that-apply) uses this; null otherwise.
						correctAnswers: {
							type: ["array", "null"],
							items: { type: "string" },
						},
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

/**
 * The same schema in Gemini's OpenAPI-subset dialect: `nullable: true` instead
 * of union types, no `additionalProperties`, and `options` left out of
 * `required` (Gemini treats required+nullable as contradictory).
 */
export function geminiQuestionSchema(): Record<string, unknown> {
	return {
		type: "object",
		required: ["questions"],
		properties: {
			questions: {
				type: "array",
				items: {
					type: "object",
					required: [
						"id",
						"type",
						"questionText",
						"explanation",
						"correctAnswer",
						"sourceTopics",
						"sourceSubtopics",
						"difficulty",
					],
					properties: {
						id: { type: "string" },
						type: { type: "string", enum: ["mcq", "multi", "integer", "decimal"] },
						questionText: { type: "string" },
						options: {
							type: "array",
							items: { type: "string" },
							nullable: true,
						},
						explanation: { type: "string" },
						correctAnswer: { type: "string" },
						correctAnswers: {
							type: "array",
							items: { type: "string" },
							nullable: true,
						},
						sourceTopics: { type: "array", items: { type: "string" } },
						sourceSubtopics: { type: "array", items: { type: "string" } },
						difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
					},
					// Gemini honors this explicitly; reasoning precedes the answer.
					propertyOrdering: [
						"id",
						"type",
						"questionText",
						"options",
						"explanation",
						"correctAnswer",
						"correctAnswers",
						"sourceTopics",
						"sourceSubtopics",
						"difficulty",
					],
				},
			},
		},
	};
}
