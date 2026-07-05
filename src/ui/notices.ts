import { Notice } from "obsidian";

/**
 * Ink-style action notices (after obsidian_ink's notice components): a small
 * plugin label, the message, then a CTA bar of real buttons. The containing
 * notice ignores pointer events (via .notice:has(.ap-notice) in styles.css)
 * so it never swallows clicks meant for the workspace; only the buttons opt
 * back in.
 */

export interface NoticeAction {
	label: string;
	/** Visual weight: primary gets accent styling, tertiary reads as a link. */
	kind?: "primary" | "tertiary";
	onClick: () => void;
}

export function showActionNotice(
	message: string,
	actions: NoticeAction[],
	options: { timeout?: number; label?: string } = {}
): Notice {
	// Notices render in the active window, so build the fragment from its document.
	const body = activeDocument.createDocumentFragment();
	const label = body.createEl("p", { cls: "ap-notice-label" });
	label.setText(options.label ?? "Adaptive Practice");
	body.createEl("p", { cls: "ap-notice-message", text: message });

	const notice = new Notice(body, options.timeout ?? 0);
	notice.messageEl.addClass("ap-notice");
	notice.messageEl.parentElement?.addClass("ap-notice-shell");

	if (actions.length > 0) {
		const bar = notice.messageEl.createDiv({ cls: "ap-notice-cta-bar" });
		for (const action of actions) {
			const button = bar.createEl("button", {
				text: action.label,
				cls:
					action.kind === "tertiary"
						? "ap-notice-tertiary-btn"
						: "ap-notice-primary-btn",
			});
			button.addEventListener("click", action.onClick);
		}
	}
	return notice;
}
