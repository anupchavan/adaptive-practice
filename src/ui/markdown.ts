import { App, Component, MarkdownRenderer } from "obsidian";
export { hasBlockMarkdown } from "./markdown-detection";
import { hasBlockMarkdown } from "./markdown-detection";

export function renderMarkdown(
	app: App,
	markdown: string,
	el: HTMLElement,
	component: Component
): void {
	el.addClass("ap-rendered-markdown");
	if (hasBlockMarkdown(markdown)) el.addClass("ap-markdown-has-block");
	void MarkdownRenderer.render(app, markdown, el, "", component);
}
