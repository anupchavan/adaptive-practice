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

export function noteDisplayAliases(
	frontmatter: Record<string, unknown> | undefined,
	displayTitle?: string
): string[] {
	const aliases: string[] = [];
	addAlias(aliases, cleanTitleValue(frontmatter?.["title"]));

	const rawAliases = frontmatter?.["aliases"];
	if (Array.isArray(rawAliases)) {
		for (const alias of rawAliases) {
			addAlias(aliases, cleanTitleValue(alias));
		}
	} else if (typeof rawAliases === "string") {
		for (const alias of rawAliases.split(",")) {
			addAlias(aliases, cleanTitleValue(alias));
		}
	}

	const titleKey = displayTitle ? normalizeAliasKey(displayTitle) : "";
	return aliases.filter((alias) => normalizeAliasKey(alias) !== titleKey);
}

function addAlias(aliases: string[], alias: string): void {
	if (!alias) return;
	const key = normalizeAliasKey(alias);
	if (!key || aliases.some((existing) => normalizeAliasKey(existing) === key)) return;
	aliases.push(alias);
}

function normalizeAliasKey(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
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
