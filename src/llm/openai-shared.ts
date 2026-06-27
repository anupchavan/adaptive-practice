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

export function questionSchema(): Record<string, unknown> {
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
