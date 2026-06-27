export function normalizeMarkdownForRender(markdown: string): string {
	if (!/(^|\s)(```|~~~)/.test(markdown)) return markdown;
	if (markdown.includes("\n") || !markdown.includes("\\n")) return markdown;
	return markdown.replace(/\\n/g, "\n");
}
