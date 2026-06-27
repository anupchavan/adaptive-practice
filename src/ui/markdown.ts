import { App, Component, MarkdownRenderer } from "obsidian";
export { hasBlockMarkdown } from "./markdown-detection";
import { hasBlockMarkdown } from "./markdown-detection";
import { normalizeMarkdownForRender } from "./markdown-normalize";

export function renderMarkdown(
	app: App,
	markdown: string,
	el: HTMLElement,
	component: Component
): void {
	const normalized = normalizeMarkdownForRender(markdown);
	el.addClass("ap-rendered-markdown");
	if (hasBlockMarkdown(normalized)) el.addClass("ap-markdown-has-block");
	try {
		void MarkdownRenderer.render(app, normalized, el, "", component).catch(() => {
			renderPlainTextFallback(normalized, el);
		});
	} catch {
		renderPlainTextFallback(normalized, el);
	}
}

function renderPlainTextFallback(markdown: string, el: HTMLElement): void {
	el.empty();
	const pre = el.createEl("pre");
	pre.setText(markdown);
}
