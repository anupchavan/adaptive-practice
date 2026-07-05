import { App, Modal, Setting } from "obsidian";

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
		this.setTitle(this.options.title);
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createDiv({
			text: this.options.message,
			cls: "ap-confirmation-message",
		});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(this.options.cancelText ?? "Cancel")
					.onClick(() => {
						this.options.onCancel?.();
						this.close();
					})
			)
			.addButton((button) => {
				button
					.setButtonText(this.options.confirmText)
					.onClick(() => {
						this.close();
						this.options.onConfirm();
					});
				if (this.options.destructive) button.setWarning();
				else button.setCta();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
