import { App, Component, Modal, Notice } from "obsidian";
import { PracticeCredit } from "../practice/daily-credit";
import { averageFluency } from "../practice/grader";
import { QuestionFeedbackKind, QuizResult, SkillDelta } from "../types";
import { hasBlockMarkdown, renderMarkdown } from "./markdown";

type QuestionFeedbackHandler = (
	result: QuizResult,
	feedback: QuestionFeedbackKind
) => void | Promise<void>;

export class ResultsModal extends Modal {
	private results: QuizResult[];
	private deltas: SkillDelta[];
	private practiceCredit: PracticeCredit | null;
	private onQuestionFeedback: QuestionFeedbackHandler | null;
	private renderComponent: Component;

	constructor(
		app: App,
		results: QuizResult[],
		deltas: SkillDelta[],
		practiceCredit: PracticeCredit | null,
		onQuestionFeedback?: QuestionFeedbackHandler
	) {
		super(app);
		this.results = results;
		this.deltas = deltas;
		this.practiceCredit = practiceCredit;
		this.onQuestionFeedback = onQuestionFeedback ?? null;
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

		contentEl.createEl("h2", { text: "Practice results" });

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

		// Skill changes
		if (this.deltas.length > 0) {
			contentEl.createEl("h3", { text: "Skill changes" });
			const skillList = contentEl.createDiv({ cls: "ap-skill-changes" });
			for (const d of this.deltas) {
				const row = skillList.createDiv({ cls: "ap-skill-row" });
				row.createEl("span", {
					text: d.title,
					cls: "ap-skill-title",
				});

				const change = d.after - d.before;
				const sign = change >= 0 ? "+" : "";
				const cls =
					change >= 0 ? "ap-skill-change-up" : "ap-skill-change-down";

				row.createEl("span", {
					text: `${Math.round(d.before)} \u2192 ${Math.round(d.after)} (${sign}${change.toFixed(1)})`,
					cls,
				});
			}
		}

		// Question review
		contentEl.createEl("h3", { text: "Question review" });
		const reviewList = contentEl.createDiv({ cls: "ap-review-list" });

		for (let i = 0; i < this.results.length; i++) {
			const r = this.results[i]!;
			const item = reviewList.createDiv({
				cls: `ap-review-item ${r.isCorrect ? "ap-review-correct" : "ap-review-incorrect"}`,
			});

			const questionWrap = item.createDiv({ cls: "ap-review-question" });
			questionWrap.createSpan({ text: `${i + 1}. `, cls: "ap-review-question-number" });
			const questionText = questionWrap.createDiv({ cls: "ap-review-question-text" });
			this.renderMarkdown(r.question.questionText, questionText);

			const details = item.createDiv({ cls: "ap-review-details" });
			this.renderReviewValue(details, "Your answer", r.skipped ? "Skipped" : r.userAnswer);
			if (!r.isCorrect) {
				this.renderReviewValue(details, "Correct", r.question.correctAnswer);
			}
			details.createEl("span", {
				text: `Time: ${formatTime(r.timeTakenMs)}`,
				cls: "ap-review-time",
			});
			this.renderFeedbackButtons(item, r);
		}

		// Close button
		const btnContainer = contentEl.createDiv({ cls: "ap-btn-container" });
		const closeBtn = btnContainer.createEl("button", {
			text: "Close",
			cls: "mod-cta",
		});
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.renderComponent.unload();
		this.contentEl.empty();
	}

	private renderReviewValue(container: HTMLElement, label: string, markdown: string): void {
		const row = container.createDiv({ cls: "ap-review-value" });
		row.createSpan({ text: `${label}: `, cls: "ap-review-value-label" });
		const value = hasBlockMarkdown(markdown)
			? row.createDiv({ cls: "ap-review-value-block" })
			: row.createSpan({ cls: "ap-review-value-inline" });
		this.renderMarkdown(markdown, value);
	}

	private renderFeedbackButtons(container: HTMLElement, result: QuizResult): void {
		if (!this.onQuestionFeedback) return;
		const row = container.createDiv({ cls: "ap-review-feedback" });
		row.createSpan({ text: "Flag question:", cls: "ap-review-feedback-label" });
		const options: Array<{ kind: QuestionFeedbackKind; label: string }> = [
			{ kind: "too_easy", label: "Too easy" },
			{ kind: "too_hard", label: "Too hard" },
			{ kind: "bad_concept", label: "Bad concept" },
		];
		for (const option of options) {
			const btn = row.createEl("button", {
				text: option.label,
				cls: "ap-review-feedback-button",
			});
			btn.addEventListener("click", () => {
				void this.saveQuestionFeedback(row, btn, result, option.kind);
			});
		}
	}

	private async saveQuestionFeedback(
		row: HTMLElement,
		button: HTMLButtonElement,
		result: QuizResult,
		feedback: QuestionFeedbackKind
	): Promise<void> {
		if (!this.onQuestionFeedback || button.disabled) return;
		row.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
			btn.disabled = true;
			btn.removeClass("is-active");
		});
		button.addClass("is-active");
		try {
			await this.onQuestionFeedback(result, feedback);
			new Notice("Question feedback saved.");
		} catch (e) {
			new Notice(`Failed to save feedback: ${e instanceof Error ? e.message : String(e)}`);
			row.querySelectorAll<HTMLButtonElement>("button").forEach((btn) => {
				btn.disabled = false;
			});
			button.removeClass("is-active");
		}
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

	private renderMarkdown(markdown: string, el: HTMLElement): void {
		renderMarkdown(this.app, markdown, el, this.renderComponent);
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
