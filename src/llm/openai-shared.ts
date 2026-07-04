export type CompatibleJsonMode = "json_schema" | "json_object" | "prompt_only";

export const MAX_OUTPUT_TOKENS = 8192;

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
						// Nullable: numeric questions return null, MCQs return strings.
						options: {
							type: ["array", "null"],
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
							nullable: true,
						},
						correctAnswer: { type: "string" },
						explanation: { type: "string" },
						sourceTopics: { type: "array", items: { type: "string" } },
						sourceSubtopics: { type: "array", items: { type: "string" } },
						difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
					},
				},
			},
		},
	};
}
