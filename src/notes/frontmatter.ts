import type { CachedMetadata } from "obsidian";

const MAX_FRONTMATTER_FIELDS = 64;
const MAX_FRONTMATTER_ARRAY_ITEMS = 24;
const MAX_FRONTMATTER_OBJECT_KEYS = 24;
const MAX_FRONTMATTER_VALUE_CHARS = 800;
const MAX_FRONTMATTER_TOTAL_CHARS = 12_000;
const SKIPPED_FRONTMATTER_KEYS = new Set(["position"]);

/**
 * Typed boundary over Obsidian's frontmatter cache: `FrontMatterCache` has an
 * `any` index signature, so this surfaces values as `unknown` for callers to
 * narrow explicitly.
 */
export function frontmatterRecord(
	cache: CachedMetadata | null | undefined
): Record<string, unknown> | undefined {
	return cache?.frontmatter;
}

export function sanitizeFrontmatter(
	frontmatter: Record<string, unknown> | undefined
): Record<string, string> {
	if (!frontmatter) return {};
	const sanitized: Record<string, string> = {};
	let totalChars = 0;
	let accepted = 0;
	let omitted = 0;

	for (const [key, value] of Object.entries(frontmatter)) {
		if (SKIPPED_FRONTMATTER_KEYS.has(key)) continue;
		if (value === null || value === undefined) continue;
		if (accepted >= MAX_FRONTMATTER_FIELDS) {
			omitted++;
			continue;
		}

		const remaining = MAX_FRONTMATTER_TOTAL_CHARS - totalChars;
		if (remaining <= 0) {
			omitted++;
			continue;
		}

		const stringified = truncateFrontmatterValue(
			stringifyFrontmatterValue(value),
			Math.min(MAX_FRONTMATTER_VALUE_CHARS, remaining)
		);
		if (!stringified) continue;
		sanitized[key] = stringified;
		totalChars += key.length + stringified.length;
		accepted++;
	}

	if (omitted > 0) {
		sanitized.__omitted = `${omitted} additional frontmatter field${omitted === 1 ? "" : "s"} omitted for prompt budget`;
	}

	return sanitized;
}

function stringifyFrontmatterValue(value: unknown, depth = 0): string {
	if (Array.isArray(value)) {
		const visible = value
			.slice(0, MAX_FRONTMATTER_ARRAY_ITEMS)
			.map((item) => stringifyFrontmatterValue(item, depth + 1))
			.filter(Boolean);
		const omitted = value.length - visible.length;
		return omitted > 0
			? `${visible.join(", ")} (+${omitted} more)`
			: visible.join(", ");
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return String(value).trim();
	}
	if (value && typeof value === "object") {
		if (depth >= 2) return "[object]";
		const entries = Object.entries(value as Record<string, unknown>)
			.slice(0, MAX_FRONTMATTER_OBJECT_KEYS)
			.map(([key, item]) => `${key}: ${stringifyFrontmatterValue(item, depth + 1)}`)
			.filter((entry) => !entry.endsWith(": "));
		const omitted = Object.keys(value).length - entries.length;
		const suffix = omitted > 0 ? `, +${omitted} more` : "";
		return `{${entries.join(", ")}${suffix}}`;
	}
	return "";
}

function truncateFrontmatterValue(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const cut = value.slice(0, Math.max(0, maxChars - 16)).trimEnd();
	return `${cut} [...truncated]`;
}
