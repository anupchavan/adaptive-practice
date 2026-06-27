export function hasBlockMarkdown(markdown: string): boolean {
	return /(^|\n)\s*(```|~~~|[-*+]\s+|\d+\.\s+|>\s+|#{1,6}\s+)/.test(markdown) ||
		/(^|\n)( {4,}|\t)/.test(markdown) ||
		/\n\s*\n/.test(markdown);
}
