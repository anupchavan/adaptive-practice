import { App, Component, HoverParent, Keymap, MarkdownRenderer } from "obsidian";
export { hasBlockMarkdown } from "./markdown-detection";
import { hasBlockMarkdown } from "./markdown-detection";
import { normalizeMarkdownForRender } from "./markdown-normalize";

export const ADAPTIVE_PRACTICE_HOVER_SOURCE = "adaptive-practice";

export interface MarkdownRenderOptions {
	sourcePath?: string;
	hoverParent?: HoverParent;
	onInternalLinkClick?: () => void;
}

export function renderMarkdown(
	app: App,
	markdown: string,
	el: HTMLElement,
	component: Component,
	options: MarkdownRenderOptions = {}
): void {
	const normalized = normalizeMarkdownForRender(markdown);
	el.addClass("ap-rendered-markdown");
	if (hasBlockMarkdown(normalized)) el.addClass("ap-markdown-has-block");
	try {
		void MarkdownRenderer.render(app, normalized, el, options.sourcePath ?? "", component)
			.then(() => {
				unwrapUnresolvedLinks(app, el, options.sourcePath ?? "");
				installInternalLinkHandlers(app, el, options);
			})
			.catch(() => {
				renderPlainTextFallback(normalized, el);
			});
	} catch {
		renderPlainTextFallback(normalized, el);
	}
}

/**
 * Replace internal links whose target does not exist with their plain text.
 * Models occasionally invent wikilinks to concepts that are not notes; inside
 * generated question text a "click to create" link is never what the learner
 * wants, so dead links are demoted to text instead of rendering as bait.
 */
function unwrapUnresolvedLinks(app: App, container: HTMLElement, sourcePath: string): void {
	const links = Array.prototype.slice.call(
		container.querySelectorAll<HTMLAnchorElement>("a.internal-link")
	) as HTMLAnchorElement[];
	for (const link of links) {
		const linktext = getInternalLinkText(link);
		const path = (linktext.split(/[#|]/)[0] ?? "").trim();
		// A pure in-note reference ("#heading") has no note target to resolve.
		if (!path) continue;
		if (app.metadataCache.getFirstLinkpathDest(path, sourcePath)) continue;
		link.replaceWith(document.createTextNode(link.textContent ?? linktext));
	}
}

function installInternalLinkHandlers(
	app: App,
	container: HTMLElement,
	options: MarkdownRenderOptions
): void {
	container.addEventListener("click", (event) => {
		const link = internalLinkFromEvent(event);
		if (!link) return;
		const linktext = getInternalLinkText(link);
		if (!linktext) return;

		event.preventDefault();
		event.stopPropagation();
		options.onInternalLinkClick?.();
		void app.workspace.openLinkText(
			linktext,
			options.sourcePath ?? "",
			Keymap.isModEvent(event)
		);
	});

	container.addEventListener("mouseover", (event) => {
		if (!options.hoverParent) return;
		const link = internalLinkFromEvent(event);
		if (!link) return;
		const linktext = getInternalLinkText(link);
		if (!linktext) return;

		app.workspace.trigger("hover-link", {
			event,
			source: ADAPTIVE_PRACTICE_HOVER_SOURCE,
			hoverParent: options.hoverParent,
			targetEl: link,
			linktext,
			sourcePath: options.sourcePath ?? "",
		});
	});
}

function internalLinkFromEvent(event: Event): HTMLAnchorElement | null {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return null;
	return target.closest<HTMLAnchorElement>("a.internal-link");
}

function getInternalLinkText(link: HTMLAnchorElement): string {
	return (
		link.getAttribute("data-href") ??
		link.getAttribute("href") ??
		link.textContent ??
		""
	).trim();
}

function renderPlainTextFallback(markdown: string, el: HTMLElement): void {
	el.empty();
	const pre = el.createEl("pre");
	pre.setText(markdown);
}
