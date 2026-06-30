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
 * JSON schema for a question batch, shaped to be compatible with OpenAI/Gemini
 * *strict* structured output: every property is listed in `required`, objects
 * set `additionalProperties: false`, `options` is nullable (so numeric questions
 * can omit it), and unsupported keywords like `minItems` are avoided. Strict
 * mode is not yet enabled on the request (that needs live-provider validation),
 * but keeping the schema strict-valid removes the previous contradictory shape
 * (`additionalProperties: false` while `options` was absent from `required`),
 * which stricter json_schema validators can reject. Flipping strict on later is
 * then a one-line change.
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
