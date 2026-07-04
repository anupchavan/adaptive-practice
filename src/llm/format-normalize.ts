import { Question } from "../types";

/**
 * Provider-agnostic output normalization. Different models (and the same model
 * behind different providers) emit math and markdown inconsistently — this is
 * the mechanical cause of the "hit or miss" formatting. Rather than trusting
 * each provider to follow the prompt, every generated question is run through
 * these deterministic repairs so the rendered result is uniform in Obsidian.
 *
 * Scope is intentionally conservative: only unambiguous, reversible transforms
 * that cannot change a question's meaning. The biggest concrete win is math
 * delimiters — Obsidian renders `$...$` / `$$...$$` but NOT the LaTeX-native
 * `\(...\)` / `\[...\]` forms that several models prefer, so those silently
 * show as raw text today.
 */

/**
 * Link the same note at most once per question. Models echo the source notes'
 * wiki/markdown links and often link the same concept several times in one stem
 * (e.g. "[[version control]] ... [[version control]] workflows"), which reads as
 * noise. The first occurrence of each distinct target stays a link; later ones
 * collapse to their display text. Image embeds (`![[...]]`, `![...](...)`) are
 * left untouched.
 */
export function dedupeRepeatedLinks(text: string, seen: Set<string>): string {
	if (!text) return text;
	const linkPattern = /\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
	return text.replace(
		linkPattern,
		(match, wiki: string, mdText: string, mdHref: string, offset: number, full: string) => {
			if (full[offset - 1] === "!") return match; // image embed
			if (typeof wiki === "string") {
				const [rawTarget = "", rawAlias] = wiki.split("|");
				const display = (rawAlias ?? rawTarget).trim();
				const key = `wiki:${normalizeLinkKey(rawTarget)}`;
				if (seen.has(key)) return display;
				seen.add(key);
				return match;
			}
			const key = `md:${normalizeLinkKey(mdHref)}`;
			if (seen.has(key)) return (mdText ?? "").trim();
			seen.add(key);
			return match;
		}
	);
}

function normalizeLinkKey(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\.md$/, "")
		.replace(/\s+/g, " ");
}

/** Convert LaTeX-native math delimiters to the `$`/`$$` forms Obsidian renders. */
export function normalizeObsidianMath(text: string): string {
	if (!text) return text;
	let out = text;
	// Display math: \[ ... \] -> $$ ... $$  (tolerate doubled backslashes)
	out = out.replace(/\\+\[([\s\S]*?)\\+\]/g, (_match, inner: string) => {
		return `$$${inner.trim()}$$`;
	});
	// Inline math: \( ... \) -> $ ... $
	out = out.replace(/\\+\(([\s\S]*?)\\+\)/g, (_match, inner: string) => {
		return `$${inner.trim()}$`;
	});
	return repairMathBraces(out);
}

/**
 * Close unbalanced braces inside math spans. A missing `}` (a common model
 * slip: `$\frac{1}{2$`) makes the whole span render as raw text in Obsidian.
 * Only the unambiguous case is repaired — up to three missing closers are
 * appended at the end of the span; anything else is left untouched.
 */
export function repairMathBraces(text: string): string {
	if (!text || !text.includes("$")) return text;
	return text.replace(
		/\$\$([\s\S]*?)\$\$|\$([^$\n]+)\$/g,
		(match, display: string | undefined, inline: string | undefined) => {
			const inner = display ?? inline;
			if (inner === undefined) return match;
			const repaired = closeUnbalancedBraces(inner);
			if (repaired === inner) return match;
			return display !== undefined ? `$$${repaired}$$` : `$${repaired}$`;
		}
	);
}

function closeUnbalancedBraces(inner: string): string {
	let depth = 0;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (inner[i - 1] === "\\") continue;
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			// An extra closer is ambiguous — do not guess.
			if (depth < 0) return inner;
		}
	}
	if (depth > 0 && depth <= 3) return inner + "}".repeat(depth);
	return inner;
}

/**
 * Normalize the rendered text fields of a question in place-safe fashion,
 * returning a new object. For MCQ the same transform is applied to every option
 * and to `correctAnswer`, so their string equality (relied on by grading and
 * highlighting) is preserved. Numeric answers are left untouched so the numeric
 * parser keeps seeing a clean value.
 */
export function normalizeQuestionFormatting(question: Question): Question {
	// One shared set across the stem and explanation so a note linked in the
	// question is not linked again in its explanation.
	const seenLinks = new Set<string>();
	const normalized: Question = {
		...question,
		questionText: dedupeRepeatedLinks(
			normalizeObsidianMath(question.questionText),
			seenLinks
		),
		explanation: dedupeRepeatedLinks(
			normalizeObsidianMath(question.explanation),
			seenLinks
		),
	};
	if ((question.type === "mcq" || question.type === "multi") && question.options) {
		// Options/correctAnswer get math normalization only (no link dedup), so
		// their string equality — relied on by grading/highlighting — is preserved.
		normalized.options = question.options.map(normalizeObsidianMath);
		normalized.correctAnswer = normalizeObsidianMath(question.correctAnswer);
		if (question.correctAnswers) {
			normalized.correctAnswers = question.correctAnswers.map(normalizeObsidianMath);
		}
	}
	return normalized;
}

export interface FormatIssues {
	latexDelimiters: number;
	unbalancedDollars: number;
	unbalancedFences: number;
	unbalancedBraces: number;
	optionPrefixes: number;
}

/**
 * Count residual formatting deviations in a question. Used by the eval harness
 * to measure per-provider consistency before and after normalization; it never
 * mutates anything. A "good" question scores zero on every field.
 */
export function detectFormatIssues(question: Question): FormatIssues {
	const fields = [
		question.questionText,
		question.explanation,
		...(question.options ?? []),
	];
	let latexDelimiters = 0;
	let unbalancedDollars = 0;
	let unbalancedFences = 0;
	let unbalancedBraces = 0;
	let optionPrefixes = 0;

	for (const field of fields) {
		if (/\\+[([]/.test(field)) latexDelimiters++;
		if (countUnescapedDollars(field) % 2 !== 0) unbalancedDollars++;
		if ((field.match(/```/g)?.length ?? 0) % 2 !== 0) unbalancedFences++;
		if (repairMathBraces(field) !== field) unbalancedBraces++;
	}
	for (const option of question.options ?? []) {
		if (/^[A-Da-d][).:]\s/.test(option.trim())) optionPrefixes++;
	}

	return { latexDelimiters, unbalancedDollars, unbalancedFences, unbalancedBraces, optionPrefixes };
}

function countUnescapedDollars(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "$" && text[i - 1] !== "\\") count++;
	}
	return count;
}
