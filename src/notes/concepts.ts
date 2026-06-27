import { NoteStructure } from "../types";

const MAX_CANDIDATE_LENGTH = 100;
const CONCEPT_KEY_RE = /topic|concept|chapter|exam|subject|unit|area|theorem|algorithm|method|mechanism|invariant|trap/i;
const CONCEPT_NOUN_RE = /\b([A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){0,5}\s+(?:invariant|boundary|complexity|edge case|failure mode|trap|overflow|condition|recurrence|memoization|partition|pivot|mechanism|assumption|limiting case|sign convention|equilibrium|exception|trend|rate law|model))\b/gi;

export function extractConceptCandidates(
	structure: Pick<NoteStructure, "title" | "frontmatter" | "tags" | "links" | "headings" | "sections">,
	limit = 18
): string[] {
	const scored = new Map<string, { value: string; score: number; order: number }>();
	let order = 0;
	const add = (value: string, score: number): void => {
		const cleaned = cleanConceptCandidate(value);
		if (!isUsefulConceptCandidate(cleaned, structure.title)) return;
		const key = normalizeConceptKey(cleaned);
		if (!key) return;
		const existing = scored.get(key);
		if (!existing || score > existing.score) {
			scored.set(key, { value: cleaned, score, order: existing?.order ?? order++ });
		}
	};

	for (const section of structure.sections) {
		if (section.heading !== "Body" && section.wordCount > 0) add(section.heading, 7);
	}
	for (const heading of structure.headings) add(heading.heading, 6);
	for (const tag of structure.tags) add(tag.replace(/^#/, ""), 3);
	for (const [key, value] of Object.entries(structure.frontmatter)) {
		if (CONCEPT_KEY_RE.test(key)) add(value, 5);
	}
	for (const link of structure.links) add(link, 1.5);
	for (const section of structure.sections) {
		for (const candidate of extractTextConceptCandidates(section.content)) {
			add(candidate.value, candidate.score);
		}
	}

	return [...scored.values()]
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.map((candidate) => candidate.value)
		.slice(0, limit);
}

function extractTextConceptCandidates(
	content: string
): Array<{ value: string; score: number }> {
	const candidates: Array<{ value: string; score: number }> = [];
	for (const match of content.matchAll(/\*\*([^*\n]{3,100})\*\*/g)) {
		candidates.push({ value: match[1] ?? "", score: 4.5 });
	}
	for (const match of content.matchAll(/__([^_\n]{3,100})__/g)) {
		candidates.push({ value: match[1] ?? "", score: 4.5 });
	}

	for (const line of content.split("\n")) {
		const bulletDefinition = /^\s*(?:[-*+]|\d+\.)\s+(?:\*\*)?([^:;\n]{3,80}?)(?:\*\*)?\s*[:–—-]\s+/.exec(line);
		if (bulletDefinition) candidates.push({ value: bulletDefinition[1] ?? "", score: 4 });

		const labelledDefinition = /^\s*(?:\*\*)?([^:;\n]{3,80}?)(?:\*\*)?\s*[:–—]\s+/.exec(line);
		if (labelledDefinition) candidates.push({ value: labelledDefinition[1] ?? "", score: 3.5 });

		for (const match of line.matchAll(CONCEPT_NOUN_RE)) {
			candidates.push({ value: match[1] ?? "", score: 3 });
		}
	}
	return candidates;
}

function cleanConceptCandidate(value: string): string {
	return value
		.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[*_#"']/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[.:;,\-–—]+$/g, "")
		.trim();
}

function isUsefulConceptCandidate(value: string, noteTitle: string): boolean {
	if (!value || value.length > MAX_CANDIDATE_LENGTH) return false;
	const key = normalizeConceptKey(value);
	if (!key || key === "body") return false;
	if (key === normalizeConceptKey(noteTitle)) return false;
	if (/^https?:\/\//i.test(value) || /^\d+(?:\.\d+)?$/.test(value)) return false;
	const words = key.split(" ");
	if (words.length > 8) return false;
	if (words.length === 1 && words[0]!.length < 4) return false;
	return true;
}

export function normalizeConceptKey(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
