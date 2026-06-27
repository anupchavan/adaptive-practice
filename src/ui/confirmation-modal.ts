import { App, Modal } from "obsidian";

export interface ConfirmationModalOptions {
	title: string;
	message: string;
	confirmText: string;
	cancelText?: string;
	destructive?: boolean;
	onConfirm: () => void;
	onCancel?: () => void;
}

export class ConfirmationModal extends Modal {
	private options: ConfirmationModalOptions;

	constructor(app: App, options: ConfirmationModalOptions) {
		super(app);
		this.options = options;
	}

	onOpen(): void {
		this.modalEl.addClass("ap-confirmation-modal");
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h3", { text: this.options.title });
		contentEl.createDiv({
			text: this.options.message,
			cls: "ap-confirmation-message",
		});

		const buttons = contentEl.createDiv({ cls: "ap-confirmation-buttons" });
		const cancel = buttons.createEl("button", {
			text: this.options.cancelText ?? "Cancel",
		});
		cancel.addEventListener("click", () => {
			this.options.onCancel?.();
			this.close();
		});

		const confirm = buttons.createEl("button", {
			text: this.options.confirmText,
			cls: this.options.destructive ? "mod-warning" : "mod-cta",
		});
		confirm.addEventListener("click", () => {
			this.close();
			this.options.onConfirm();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
