import { App, Component, Modal, setIcon } from "obsidian";
import { Question, QuizResult } from "../types";
import { checkAnswer } from "../practice/grader";
import { adaptQuestionOrderForFlow } from "../practice/flow-navigation";
import { hasBlockMarkdown, renderMarkdown } from "./markdown";
import { ConfirmationModal } from "./confirmation-modal";

export class QuizModal extends Modal {
	private questions: Question[];
	private results: QuizResult[] = [];
	private currentIndex = 0;
	private onComplete: (results: QuizResult[]) => void;
	private onExpand: ((questions: Question[], results: QuizResult[], currentIndex: number) => void) | null;
	private renderComponent: Component;

	private selectedAnswer = "";
	private hasChecked = false;
	private questionStartTime = 0;
	private allowClose = false;
	private closeConfirmationOpen = false;

	constructor(
		app: App,
		questions: Question[],
		onComplete: (results: QuizResult[]) => void,
		onExpand?: (questions: Question[], results: QuizResult[], currentIndex: number) => void
	) {
		super(app);
		this.questions = questions;
		this.onComplete = onComplete;
		this.onExpand = onExpand ?? null;
		this.renderComponent = new Component();
	}

	onOpen(): void {
		this.modalEl.addClass("ap-quiz-modal");
		this.renderComponent.load();

		if (this.onExpand) {
			this.renderExpandButton();
		}

		this.renderQuestion();
	}

	onClose(): void {
		this.renderComponent.unload();
		this.contentEl.empty();
	}

	close(): void {
		if (this.shouldConfirmClose()) {
			this.openCloseConfirmation();
			return;
		}
		super.close();
	}

	private renderExpandButton(): void {
		this.modalEl.querySelector(".ap-expand-button")?.remove();
		const expandBtn = createEl("button", {
			cls: "clickable-icon ap-expand-button",
			attr: {
				"aria-label": "Open in full tab",
				type: "button",
			},
		});
		setIcon(expandBtn, "external-link");
		expandBtn.setAttribute("title", "Open in full tab");
		expandBtn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			const handler = this.onExpand;
			this.onExpand = null;
			this.onComplete = () => {};
			this.allowClose = true;
			this.close();
			handler?.(this.questions, this.results, this.currentIndex);
		});
		this.modalEl.appendChild(expandBtn);
	}

	private shouldConfirmClose(): boolean {
		return (
			!this.allowClose &&
			this.questions.length > 0 &&
			this.results.length < this.questions.length
		);
	}

	private openCloseConfirmation(): void {
		if (this.closeConfirmationOpen) return;
		this.closeConfirmationOpen = true;
		new ConfirmationModal(this.app, {
			title: "End practice session?",
			message: "Generated questions and answers from this unfinished session will be discarded.",
			confirmText: "End session",
			cancelText: "Keep practicing",
			destructive: true,
			onConfirm: () => {
				this.allowClose = true;
				this.closeConfirmationOpen = false;
				this.close();
			},
			onCancel: () => {
				this.closeConfirmationOpen = false;
			},
		}).open();
	}

	private renderQuestion(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.selectedAnswer = "";
		this.hasChecked = false;
		this.questionStartTime = Date.now();

		const q = this.questions[this.currentIndex];
		if (!q) return;

		const progressWrap = contentEl.createDiv({ cls: "ap-progress" });
		const track = progressWrap.createDiv({ cls: "ap-progress-track" });
		const fill = track.createDiv({ cls: "ap-progress-fill" });
		const pct = ((this.currentIndex) / this.questions.length) * 100;
		fill.style.width = `${pct}%`;
		progressWrap.createEl("span", {
			text: `${this.currentIndex + 1} / ${this.questions.length}`,
			cls: "ap-progress-text",
		});

		const meta = contentEl.createDiv({ cls: "ap-question-meta" });
		meta.createEl("span", {
			text: q.difficulty,
			cls: `ap-badge ap-badge-${q.difficulty}`,
		});
		meta.createEl("span", {
			text: q.type.toUpperCase(),
			cls: "ap-badge",
		});

		const questionEl = contentEl.createDiv({ cls: "ap-question-text" });
		this.renderMarkdown(q.questionText, questionEl);

		const answerArea = contentEl.createDiv({ cls: "ap-answer-area" });

		if (q.type === "mcq" && q.options) {
			this.renderMCQ(answerArea, q.options);
		} else if (q.type === "integer" || q.type === "decimal") {
			this.renderNumericInput(answerArea, q.type);
		}

		const feedbackEl = contentEl.createDiv({ cls: "ap-feedback" });

		const btnRow = contentEl.createDiv({ cls: "ap-btn-container" });

		const skipBtn = btnRow.createEl("button", { text: "Skip" });
		skipBtn.addEventListener("click", () => {
			if (this.hasChecked) return;
			this.hasChecked = true;
			const elapsed = Date.now() - this.questionStartTime;
			this.results.push({
				question: q,
				userAnswer: "",
				isCorrect: false,
				skipped: true,
				timeTakenMs: elapsed,
			});
			adaptQuestionOrderForFlow(this.questions, this.results, this.currentIndex);
			this.advance();
		});

		const checkBtn = btnRow.createEl("button", {
			text: "Check",
			cls: "mod-cta",
		});
		checkBtn.addEventListener("click", () => {
			if (this.hasChecked) return;
			if (!this.selectedAnswer) return;

			this.hasChecked = true;
			const elapsed = Date.now() - this.questionStartTime;
			const isCorrect = checkAnswer(q, this.selectedAnswer);

			this.results.push({
				question: q,
				userAnswer: this.selectedAnswer,
				isCorrect,
				skipped: false,
				timeTakenMs: elapsed,
			});
			adaptQuestionOrderForFlow(this.questions, this.results, this.currentIndex);

			this.showFeedback(feedbackEl, isCorrect, q);
			checkBtn.remove();
			skipBtn.remove();
			this.showNextButton(btnRow);
			this.highlightAnswer(answerArea, q, isCorrect);
		});
	}

	private renderMCQ(container: HTMLElement, options: string[]): void {
		const radioName = `ap-mcq-${this.currentIndex}`;
		for (const opt of options) {
			const label = container.createEl("label", { cls: "ap-option" });
			if (hasBlockMarkdown(opt)) {
				label.addClass("ap-option-has-block");
			}
			const radio = label.createEl("input", { type: "radio" });
			radio.name = radioName;
			radio.value = opt;
			radio.addEventListener("change", () => {
				this.selectedAnswer = opt;
				container
					.querySelectorAll(".ap-option")
					.forEach((el) => el.removeClass("ap-option-selected"));
				label.addClass("ap-option-selected");
			});
			const optTextEl = label.createDiv({ cls: "ap-option-text" });
			this.renderMarkdown(opt, optTextEl);
		}
	}

	private renderNumericInput(
		container: HTMLElement,
		type: "integer" | "decimal"
	): void {
		const input = container.createEl("input", {
			type: "text",
			cls: "ap-numeric-input",
			placeholder: type === "integer" ? "Enter an integer" : "Enter a number",
		});
		if (type === "integer") {
			input.inputMode = "numeric";
		} else {
			input.inputMode = "decimal";
		}
		input.addEventListener("input", () => {
			this.selectedAnswer = input.value;
		});
	}

	private showFeedback(
		el: HTMLElement,
		isCorrect: boolean,
		q: Question
	): void {
		el.empty();
		el.addClass(isCorrect ? "ap-feedback-correct" : "ap-feedback-incorrect");

		el.createEl("strong", {
			text: isCorrect ? "Correct!" : "Incorrect",
		});

		if (!isCorrect) {
			const correctEl = el.createDiv();
			correctEl.createEl("span", { text: "Correct answer: " });
			const ansEl = hasBlockMarkdown(q.correctAnswer)
				? correctEl.createDiv({ cls: "ap-correct-answer-block" })
				: correctEl.createSpan();
			this.renderMarkdown(q.correctAnswer, ansEl);
		}

		const explanationEl = el.createDiv({ cls: "ap-explanation" });
		this.renderMarkdown(q.explanation, explanationEl);
	}

	private highlightAnswer(
		container: HTMLElement,
		q: Question,
		isCorrect: boolean
	): void {
		if (q.type !== "mcq") return;

		container.querySelectorAll(".ap-option").forEach((el) => {
			const radio = el.querySelector<HTMLInputElement>("input");
			if (!radio) return;
			if (radio.value === q.correctAnswer) {
				el.addClass("ap-option-correct");
			} else if (radio.checked && !isCorrect) {
				el.addClass("ap-option-wrong");
			}
			radio.disabled = true;
		});
	}

	private showNextButton(container: HTMLElement): void {
		const isLast = this.currentIndex >= this.questions.length - 1;
		const btn = container.createEl("button", {
			text: isLast ? "See results" : "Next",
			cls: "mod-cta",
		});
		btn.addEventListener("click", () => this.advance());
	}

	private advance(): void {
		const isLast = this.currentIndex >= this.questions.length - 1;
		if (isLast) {
			this.allowClose = true;
			this.close();
			this.onComplete(this.results);
		} else {
			this.currentIndex++;
			this.renderQuestion();
		}
	}

	private renderMarkdown(md: string, el: HTMLElement): void {
		renderMarkdown(this.app, md, el, this.renderComponent);
	}
}
