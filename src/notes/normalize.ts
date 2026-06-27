import { NoteSection } from "../types";

const DEFAULT_SKILL = 50;

const CLIPPER_GARBAGE_PATTERNS = [
	/^skip to (main )?content$/i,
	/^subscribe$/i,
	/^sign in$/i,
	/^log in$/i,
	/^accept (all )?(cookies|cookie)$/i,
	/^cookie preferences$/i,
	/^share$/i,
	/^copy link$/i,
	/^advertisement$/i,
	/^sponsored$/i,
	/^related (articles|posts)$/i,
	/^read more$/i,
	/^previous$/i,
	/^next$/i,
	/^home\s*[|/]/i,
	/^menu$/i,
	/^open menu$/i,
	/^search$/i,
	/^table of contents$/i,
	/^follow us$/i,
	/^enable javascript$/i,
	/^loading\.?$/i,
	/^all rights reserved\.?$/i,
	/^©\s*\d{4}/i,
];

export interface InternalEmbedReference {
	link: string;
	alt: string;
}

export interface MarkdownImageReference {
	link: string;
	alt: string;
	caption: string;
	isRemote: boolean;
}

export function cleanNoteText(content: string): string {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const cleaned: string[] = [];
	let inFence = false;
	let blankRun = 0;

	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			cleaned.push(line);
			blankRun = 0;
			continue;
		}

		if (!inFence && isLikelyClippedGarbage(line)) continue;

		if (line.trim() === "") {
			blankRun++;
			if (blankRun <= 2) cleaned.push("");
			continue;
		}

		blankRun = 0;
		cleaned.push(line.trimEnd());
	}

	return cleaned.join("\n").trim();
}

export function extractSections(content: string): NoteSection[] {
	const sections: Array<{ heading: string; level: number; lines: string[] }> = [];
	let current = { heading: "Body", level: 0, lines: [] as string[] };

	for (const line of content.split("\n")) {
		const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (headingMatch) {
			if (current.lines.join("\n").trim() || current.heading !== "Body") {
				sections.push(current);
			}
			current = {
				heading: headingMatch[2] ?? "Untitled section",
				level: headingMatch[1]?.length ?? 1,
				lines: [],
			};
			continue;
		}
		current.lines.push(line);
	}

	if (current.lines.join("\n").trim() || sections.length === 0) {
		sections.push(current);
	}

	return sections.map((section) => {
		const sectionContent = section.lines.join("\n").trim();
		return {
			heading: section.heading,
			level: section.level,
			content: sectionContent,
			wordCount: countWords(sectionContent),
		};
	});
}

export function parseInternalEmbedReference(raw: string): InternalEmbedReference {
	const [target = "", ...aliasParts] = raw.split("|");
	const alias = aliasParts.join("|").trim();
	const link = target.replace(/#.*$/, "").trim();
	return {
		link,
		alt: normalizeMediaAlt(alias, link),
	};
}

export function cleanMarkdownPath(path: string): string {
	let cleaned = path.trim();
	if (cleaned.startsWith("<")) {
		const end = cleaned.indexOf(">");
		if (end !== -1) cleaned = cleaned.slice(1, end);
	} else {
		cleaned = cleaned.replace(/\s+["'][^"']*["']\s*$/, "");
		cleaned = cleaned.replace(/^['"]|['"]$/g, "");
	}
	return safeDecodeUriComponent(cleaned.trim());
}

export function parseMarkdownImageReferences(content: string): MarkdownImageReference[] {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	const refs: MarkdownImageReference[] = [];
	const markdownImageRe = /!\[([^\]]*)\]\(([^)]+)\)/g;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] ?? "";
		markdownImageRe.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = markdownImageRe.exec(line)) !== null) {
			const link = normalizeRemoteMarkdownUrl(cleanMarkdownPath(match[2] ?? ""));
			if (!link) continue;
			refs.push({
				link,
				alt: (match[1] ?? "").trim() || link,
				caption: findNearbyImageCaption(lines, lineIndex),
				isRemote: isRemoteMarkdownUrl(link),
			});
		}
	}

	return refs;
}

export function parseSkillValue(value: unknown, fallback = DEFAULT_SKILL): number {
	const numberValue = typeof value === "number"
		? value
		: typeof value === "string"
			? Number(value.trim())
			: NaN;
	if (!Number.isFinite(numberValue)) return fallback;
	return Math.min(100, Math.max(0, numberValue));
}

function isLikelyClippedGarbage(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) return false;
	if (CLIPPER_GARBAGE_PATTERNS.some((pattern) => pattern.test(trimmed))) return true;
	if (/^#+\s*(share|related|advertisement|subscribe)\b/i.test(trimmed)) return true;
	if (/^\[(share|tweet|subscribe|sign in|log in)\]\(/i.test(trimmed)) return true;
	if (/^!\[.*\]\((?:https?:)?\/\/(?:pixel|adservice|doubleclick)\./i.test(trimmed)) return true;
	return false;
}

function normalizeMediaAlt(alias: string, link: string): string {
	if (!alias) return link;
	if (/^\d+(?:x\d+)?$/i.test(alias)) return link;
	return alias;
}

function findNearbyImageCaption(lines: string[], imageLineIndex: number): string {
	for (let offset = 1; offset <= 4; offset++) {
		const line = lines[imageLineIndex + offset];
		if (line === undefined) break;
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (isClearlyNotImageCaption(trimmed)) return "";
		return cleanCaptionText(trimmed);
	}
	return "";
}

function isClearlyNotImageCaption(line: string): boolean {
	return /^!\[/.test(line) ||
		/^#{1,6}\s+/.test(line) ||
		/^```/.test(line) ||
		/^\|.*\|$/.test(line) ||
		/^[-*+]\s+/.test(line) ||
		/^\d+\.\s+/.test(line);
}

function cleanCaptionText(line: string): string {
	return line
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_`]/g, "")
		.trim();
}

function normalizeRemoteMarkdownUrl(link: string): string {
	if (link.startsWith("//")) return `https:${link}`;
	return link;
}

function isRemoteMarkdownUrl(link: string): boolean {
	return /^(https?:)?\/\//i.test(link);
}

function safeDecodeUriComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function countWords(text: string): number {
	const matches = text.match(/\S+/g);
	return matches ? matches.length : 0;
}
