export function noteDisplayTitle(
	frontmatter: Record<string, unknown> | undefined,
	fallback: string
): string {
	const title = cleanTitleValue(frontmatter?.["title"]);
	if (title) return title;

	const aliases = frontmatter?.["aliases"];
	if (Array.isArray(aliases)) {
		for (const alias of aliases) {
			const cleaned = cleanTitleValue(alias);
			if (cleaned) return cleaned;
		}
	} else if (typeof aliases === "string") {
		for (const alias of aliases.split(",")) {
			const cleaned = cleanTitleValue(alias);
			if (cleaned) return cleaned;
		}
	}

	return cleanTitleValue(fallback) || fallback;
}

function cleanTitleValue(value: unknown): string {
	if (
		typeof value !== "string" &&
		typeof value !== "number" &&
		typeof value !== "boolean"
	) {
		return "";
	}
	const cleaned = String(value)
		.trim()
		.replace(/^\[\[|\]\]$/g, "")
		.replace(/\s+/g, " ");
	if (!cleaned || cleaned.length > 180) return "";
	return cleaned;
}
