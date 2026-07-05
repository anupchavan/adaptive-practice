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
 * Unwrap internal links to plain text. Model-written links are forbidden in
 * question content — the app reveals the source note after answering — and a
 * link that RESOLVES is worse than a dead one: it names the source note in
 * the stem and hands the learner the answer's category (the render-time guard
 * only demotes dead links). Image embeds and external http(s) links survive.
 * Code fences, inline code, and math spans are never touched, so code like
 * bash `[[ -f x ]]` or `a[0](b)` cannot be mangled.
 */
export function unwrapInternalLinks(text: string): string {
	if (!text || (!text.includes("[[") && !text.includes("]("))) return text;
	const segments = text.split(
		/(```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g
	);
	const linkPattern = /\[\[([^[\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
	return segments
		.map((segment, index) => {
			if (index % 2 === 1) return segment;
			return segment.replace(
				linkPattern,
				(match, wiki: string, mdText: string, mdHref: string, offset: number, full: string) => {
					if (full[offset - 1] === "!") return match; // image embed
					if (typeof wiki === "string") {
						const [rawTarget = "", rawAlias] = wiki.split("|");
						return (rawAlias ?? rawTarget).trim();
					}
					if (/^https?:\/\//i.test(mdHref.trim())) return match;
					return (mdText ?? "").trim();
				}
			);
		})
		.join("");
}

/**
 * Backtick-wrap prose tokens containing `==`. Obsidian renders `==text==` as
 * a highlight (`<mark>`), so an unwrapped comparison like `a==b==c` silently
 * mangles into "a<mark>b</mark>c". Code fences, inline code, and math spans
 * are left untouched; in prose, any whitespace-delimited token containing
 * `==` is by construction code-like, so wrapping it is what the model should
 * have done. Trailing sentence punctuation stays outside the code span.
 */
export function escapeBareHighlights(text: string): string {
	if (!text || !text.includes("==")) return text;
	const segments = text.split(
		/(```[\s\S]*?(?:```|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g
	);
	return segments
		.map((segment, index) => {
			if (index % 2 === 1) return segment;
			return segment.replace(/[^\s`]*==[^\s`]*/g, (token) => {
				const stripped = token.replace(/[.,;:!?]+$/, "");
				if (!stripped.includes("==")) return token;
				return `\`${stripped}\`${token.slice(stripped.length)}`;
			});
		})
		.join("");
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
	// Math first so math spans are in `$` form when the link unwrap and the
	// highlight escape decide which segments are protected.
	const normalizeInline = (text: string): string =>
		escapeBareHighlights(unwrapInternalLinks(normalizeObsidianMath(text)));
	const normalized: Question = {
		...question,
		questionText: normalizeInline(question.questionText),
		explanation: normalizeInline(question.explanation),
	};
	if ((question.type === "mcq" || question.type === "multi") && question.options) {
		// Options/correctAnswer get the same inline transforms (no link dedup), so
		// their string equality — relied on by grading/highlighting — is preserved.
		normalized.options = question.options.map(normalizeInline);
		normalized.correctAnswer = normalizeInline(question.correctAnswer);
		if (question.correctAnswers) {
			normalized.correctAnswers = question.correctAnswers.map(normalizeInline);
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
	/** 1 when the correct MCQ option is strictly the longest — the classic
	 * test-wiseness giveaway ("when unsure, pick the longest"). */
	correctLongestOption: number;
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

	return {
		latexDelimiters,
		unbalancedDollars,
		unbalancedFences,
		unbalancedBraces,
		optionPrefixes,
		correctLongestOption: correctOptionIsLongest(question) ? 1 : 0,
	};
}

function correctOptionIsLongest(question: Question): boolean {
	if (question.type !== "mcq" || !question.options) return false;
	const wordCount = (text: string): number =>
		text.split(/\s+/).filter(Boolean).length;
	const correct = wordCount(question.correctAnswer);
	return question.options.every(
		(option) => option === question.correctAnswer || wordCount(option) < correct
	);
}

function countUnescapedDollars(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "$" && text[i - 1] !== "\\") count++;
	}
	return count;
}
