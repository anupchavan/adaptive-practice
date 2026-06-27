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
	const referenceDefinitions = parseMarkdownReferenceDefinitions(lines);

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const line = lines[lineIndex] ?? "";
		for (const image of scanMarkdownImages(line, referenceDefinitions)) {
			const link = normalizeRemoteMarkdownUrl(cleanMarkdownPath(image.link));
			if (!link) continue;
			refs.push({
				link,
				alt: image.alt.trim() || link,
				caption: findNearbyImageCaption(lines, lineIndex),
				isRemote: isRemoteMarkdownUrl(link),
			});
		}
	}

	return refs;
}

function parseMarkdownReferenceDefinitions(lines: string[]): Map<string, string> {
	const definitions = new Map<string, string>();
	for (const line of lines) {
		const match = /^\s{0,3}\[([^\]]+)\]:\s*(.+?)\s*$/.exec(line);
		if (!match) continue;
		const label = normalizeReferenceLabel(match[1] ?? "");
		const destination = (match[2] ?? "").trim();
		if (!label || !destination) continue;
		definitions.set(label, destination);
	}
	return definitions;
}

function scanMarkdownImages(
	line: string,
	referenceDefinitions: Map<string, string>
): Array<{ alt: string; link: string }> {
	const images: Array<{ alt: string; link: string }> = [];
	let cursor = 0;
	while (cursor < line.length) {
		const start = line.indexOf("![", cursor);
		if (start === -1) break;
		const altEnd = findClosingBracket(line, start + 2);
		if (altEnd === -1) break;
		const alt = line.slice(start + 2, altEnd);
		const next = line[altEnd + 1];
		if (next === "(") {
			const destination = readMarkdownDestination(line, altEnd + 2);
			if (!destination) {
				cursor = altEnd + 2;
				continue;
			}
			images.push({ alt, link: destination.value });
			cursor = destination.end + 1;
			continue;
		}
		if (next === "[") {
			const labelEnd = findClosingBracket(line, altEnd + 2);
			if (labelEnd === -1) {
				cursor = altEnd + 2;
				continue;
			}
			const rawLabel = line.slice(altEnd + 2, labelEnd).trim() || alt;
			const destination = referenceDefinitions.get(
				normalizeReferenceLabel(rawLabel)
			);
			if (destination) {
				images.push({ alt, link: destination });
			}
			cursor = labelEnd + 1;
			continue;
		}
		cursor = altEnd + 1;
	}
	return images;
}

function findClosingBracket(line: string, start: number): number {
	for (let index = start; index < line.length; index++) {
		if (line[index] === "\\") {
			index++;
			continue;
		}
		if (line[index] === "]") return index;
	}
	return -1;
}

function readMarkdownDestination(
	line: string,
	start: number
): { value: string; end: number } | null {
	let depth = 0;
	for (let index = start; index < line.length; index++) {
		const char = line[index];
		if (char === "\\") {
			index++;
			continue;
		}
		if (char === "(") {
			depth++;
			continue;
		}
		if (char === ")") {
			if (depth === 0) {
				return {
					value: line.slice(start, index),
					end: index,
				};
			}
			depth--;
		}
	}
	return null;
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
		/^\[[^\]]+\]:/.test(line) ||
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

function normalizeReferenceLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase();
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
