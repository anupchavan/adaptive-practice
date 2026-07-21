import { App, Component, Modal, Setting } from "obsidian";
import { PracticeCredit } from "../practice/daily-credit";
import { averageFluency } from "../practice/grader";
import { QuizResult, SkillDelta } from "../types";

export class ResultsModal extends Modal {
	private results: QuizResult[];
	private deltas: SkillDelta[];
	private practiceCredit: PracticeCredit | null;
	private renderComponent: Component;

	constructor(
		app: App,
		results: QuizResult[],
		deltas: SkillDelta[],
		practiceCredit: PracticeCredit | null
	) {
		super(app);
		this.results = results;
		this.deltas = deltas;
		this.practiceCredit = practiceCredit;
		this.renderComponent = new Component();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ap-results-modal");
		this.renderComponent.load();

		const correct = this.results.filter((r) => r.isCorrect).length;
		const total = this.results.length;
		const skipped = this.results.filter((r) => r.skipped).length;
		const averageTimeMs =
			total > 0
				? this.results.reduce((sum, result) => sum + result.timeTakenMs, 0) / total
				: 0;
		const fluency = averageFluency(this.results);

		this.setTitle("Practice results");

		// Score summary
		const scoreEl = contentEl.createDiv({ cls: "ap-score-summary" });
		scoreEl.createEl("span", {
			text: `${correct}`,
			cls: "ap-score-correct",
		});
		scoreEl.createEl("span", { text: ` / ${total} correct` });
		const scoreStats = contentEl.createDiv({ cls: "ap-results-stats" });
		scoreStats.createDiv({ text: `Skipped: ${skipped}`, cls: "ap-results-stat" });
		scoreStats.createDiv({
			text: `Avg time: ${formatTime(averageTimeMs)}`,
			cls: "ap-results-stat",
		});
		scoreStats.createDiv({
			text: `Fluency: ${Math.round(fluency * 100)}%`,
			cls: "ap-results-stat",
		});
		if (this.practiceCredit) this.renderPracticeCredit(contentEl);

		// The app's results anatomy: which notes' review schedules moved,
		// stated as direction, never as raw skill arithmetic.
		if (this.deltas.length > 0) {
			new Setting(contentEl).setName("Review schedule updated").setHeading();
			const list = contentEl.createDiv({ cls: "ap-skill-changes" });
			for (const delta of this.deltas) {
				const row = list.createDiv({ cls: "ap-skill-row" });
				row.createEl("span", { text: delta.title, cls: "ap-skill-title" });
				const strengthened = delta.after >= delta.before;
				row.createEl("span", {
					text: strengthened ? "interval strengthened" : "review sooner",
					cls: strengthened ? "ap-skill-change-up" : "ap-skill-change-down",
				});
			}
		}

		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Close").setCta().onClick(() => this.close())
		);
	}

	onClose(): void {
		this.renderComponent.unload();
		this.contentEl.empty();
	}




	private renderPracticeCredit(container: HTMLElement): void {
		if (!this.practiceCredit) return;
		const banner = container.createDiv({
			cls: `ap-results-credit ap-results-credit-${this.practiceCredit.status}`,
		});
		banner.createDiv({
			text: this.practiceCredit.title,
			cls: "ap-results-credit-title",
		});
		banner.createDiv({
			text: this.practiceCredit.detail,
			cls: "ap-results-credit-detail",
		});
	}

}

function formatTime(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
