import {
	App,
	Component,
	ItemView,
	Modal,
	Notice,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import { Question, QuizResult, TopicNote } from "../types";
import { checkAnswer } from "../practice/grader";
import { adaptQuestionOrderForFlow } from "../practice/flow-navigation";
import { hasAnsweredEveryQuestion } from "../practice/results";
import { appendSingleQuestion, removeSingleQuestion } from "../notes/writer";
import { ConfirmationModal } from "./confirmation-modal";
import { hasBlockMarkdown, renderMarkdown } from "./markdown";

export const PRACTICE_VIEW_TYPE = "adaptive-practice-view";

interface PracticeState {
	questions: Question[];
	results: QuizResult[];
	currentIndex: number;
	topics: TopicNote[];
	onComplete: (results: QuizResult[]) => void;
	onDiscard?: () => void | Promise<void>;
	onStateChange?: (questions: Question[], results: QuizResult[], currentIndex: number) => void;
	questionPaneSide: "left" | "right";
}

const MAX_VISIBLE_TOPICS = 3;

export class PracticeView extends ItemView {
	private state: PracticeState | null = null;
	private renderComponent: Component;
	private selectedAnswer = "";
	private hasChecked = false;
	private questionStartTime = 0;
	private keyHandler: ((e: KeyboardEvent) => void) | null = null;
	private savedIndices = new Set<number>();
	private completed = false;
	hoverPopover = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.renderComponent = new Component();
	}

	getViewType(): string {
		return PRACTICE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Practice";
	}

	getIcon(): string {
		return "graduation-cap";
	}

	setPracticeState(state: PracticeState): void {
		this.state = state;
		this.completed = false;
		this.savedIndices.clear();
		this.renderComponent.load();
		this.render();
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("ap-practice-view");
	}

	async onClose(): Promise<void> {
		if (this.hasAnsweredAllQuestions()) {
			this.finishCompletedSession();
		} else {
			this.emitStateChange();
		}
		this.removeKeyHandler();
		this.renderComponent.unload();
		this.contentEl.empty();
	}

	private removeKeyHandler(): void {
		if (this.keyHandler) {
			document.removeEventListener("keydown", this.keyHandler);
			this.keyHandler = null;
		}
	}

	private installKeyHandler(q: Question, container: HTMLElement): void {
		this.removeKeyHandler();

		this.keyHandler = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "radio") return;

			if (!this.hasChecked) {
				if (q.type === "mcq" && q.options) {
					const letterMap: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };
					const idx = letterMap[e.key.toLowerCase()];
					if (idx !== undefined && idx < q.options.length) {
						e.preventDefault();
						this.selectedAnswer = q.options[idx]!;
						container.querySelectorAll(".ap-pv-option").forEach((el, i) => {
							el.removeClass("ap-pv-option-selected");
							if (i === idx) el.addClass("ap-pv-option-selected");
						});
					}
				}

				if (e.key === "Enter" && this.selectedAnswer) {
					e.preventDefault();
					const checkBtn = container.querySelector<HTMLButtonElement>(".ap-pv-btn-check");
					checkBtn?.click();
				}
			}

			if (this.hasChecked || this.state?.results[this.state.currentIndex]) {
				this.handleArrowNavigation(e);
			}
		};
		document.addEventListener("keydown", this.keyHandler);
	}

	private installAnsweredKeyHandler(): void {
		this.removeKeyHandler();
		this.keyHandler = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			if (target.tagName === "INPUT") return;
			this.handleArrowNavigation(e);
		};
		document.addEventListener("keydown", this.keyHandler);
	}

	private handleArrowNavigation(e: KeyboardEvent): void {
		if (!this.state) return;
		const s = this.state;
		const furthest = this.getFurthestReachableIndex();

		if (e.key === "ArrowRight" && s.currentIndex < furthest) {
			e.preventDefault();
			s.currentIndex++;
			this.emitStateChange();
			this.render();
		} else if (e.key === "ArrowLeft" && s.currentIndex > 0) {
			e.preventDefault();
			s.currentIndex--;
			this.emitStateChange();
			this.render();
		}
	}

	private render(): void {
		this.removeKeyHandler();
		if (!this.state) return;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ap-practice-view");

		const wrapper = contentEl.createDiv({ cls: "ap-pv-wrapper" });
		if (this.state.questionPaneSide === "right") {
			wrapper.addClass("ap-pv-wrapper-sidebar-right");
		}
		const sidebar = wrapper.createDiv({ cls: "ap-pv-sidebar" });
		const main = wrapper.createDiv({ cls: "ap-pv-main" });

		this.renderSidebar(sidebar);
		this.renderMainContent(main);
	}

	private renderSidebar(container: HTMLElement): void {
		const s = this.state!;

		const header = container.createDiv({ cls: "ap-pv-sidebar-header" });
		header.createEl("div", { text: "Practice", cls: "ap-pv-sidebar-title" });

		const topicNames = [...new Set(s.questions.flatMap((q) => q.sourceTopics))];
		if (topicNames.length > 0) {
			if (topicNames.length <= MAX_VISIBLE_TOPICS) {
				header.createEl("div", {
					text: topicNames.join(", "),
					cls: "ap-pv-sidebar-topic",
				});
			} else {
				const summary = header.createEl("div", { cls: "ap-pv-sidebar-topic ap-pv-topic-clickable" });
				summary.setText(`${topicNames.slice(0, MAX_VISIBLE_TOPICS).join(", ")} +${topicNames.length - MAX_VISIBLE_TOPICS} more`);
				summary.addEventListener("click", () => {
					new TopicListModal(this.app, this.sessionTopicsForTitles(topicNames)).open();
				});
			}
		}

		const grid = container.createDiv({ cls: "ap-pv-grid" });
		const furthestReachable = this.getFurthestReachableIndex();

		for (let i = 0; i < s.questions.length; i++) {
			const cell = grid.createDiv({ cls: "ap-pv-grid-cell" });
			cell.setText(`${i + 1}`);

			const result = s.results[i];
			if (result) {
				if (result.skipped) {
					cell.addClass("ap-pv-grid-skipped");
				} else if (result.isCorrect) {
					cell.addClass("ap-pv-grid-correct");
				} else {
					cell.addClass("ap-pv-grid-incorrect");
				}
			}

			if (i === s.currentIndex) {
				cell.addClass("ap-pv-grid-current");
			}

			if (i <= furthestReachable) {
				cell.addClass("ap-pv-grid-clickable");
				cell.addEventListener("click", () => {
					s.currentIndex = i;
					this.emitStateChange();
					this.render();
				});
			}
		}

		const stats = container.createDiv({ cls: "ap-pv-stats" });
		const correct = s.results.filter((r) => r.isCorrect).length;
		const wrong = s.results.filter((r) => !r.isCorrect && !r.skipped).length;
		const skipped = s.results.filter((r) => r.skipped).length;

		this.addStatRow(stats, "Right answers", `${correct}`, "ap-pv-stat-correct");
		this.addStatRow(stats, "Wrong answers", `${wrong}`, "ap-pv-stat-wrong");
		this.addStatRow(stats, "Skipped", `${skipped}`, "ap-pv-stat-skipped");

		this.renderSessionActions(container);
	}

	private addStatRow(container: HTMLElement, label: string, value: string, cls: string): void {
		const row = container.createDiv({ cls: "ap-pv-stat-row" });
		row.createEl("span", { text: label, cls: "ap-pv-stat-label" });
		row.createEl("span", { text: value, cls: `ap-pv-stat-value ${cls}` });
	}

	private renderSessionActions(container: HTMLElement): void {
		const s = this.state!;
		const actions = container.createDiv({ cls: "ap-pv-session-actions" });

		const finishLater = actions.createEl("button", {
			text: "Finish later",
			cls: "ap-pv-sidebar-button",
		});
		finishLater.addEventListener("click", () => {
			this.emitStateChange();
			new Notice("Practice session saved.");
			void this.leaf.detach();
		});

		if (!s.onDiscard) return;

		const discard = actions.createEl("button", {
			text: "Discard session",
			cls: "ap-pv-sidebar-button ap-pv-sidebar-button-danger",
		});
		discard.addEventListener("click", () => {
			new ConfirmationModal(this.app, {
				title: "Discard practice session?",
				message: "Generated questions and answers from this unfinished session will be discarded.",
				confirmText: "Discard",
				cancelText: "Keep practicing",
				destructive: true,
				onConfirm: () => {
					void (async () => {
						try {
							await s.onDiscard?.();
							this.leaf.detach();
						} catch (e) {
							new Notice(`Failed to discard: ${e instanceof Error ? e.message : String(e)}`);
						}
					})();
				},
			}).open();
		});
	}

	private getFurthestReachableIndex(): number {
		const s = this.state!;
		let last = -1;
		for (let i = 0; i < s.questions.length; i++) {
			if (s.results[i]) {
				last = i;
			} else {
				break;
			}
		}
		return Math.min(last + 1, s.questions.length - 1);
	}

	private hasAnsweredAllQuestions(): boolean {
		const s = this.state;
		return !!s && hasAnsweredEveryQuestion(s.questions, s.results);
	}

	private finishCompletedSession(): void {
		const s = this.state;
		if (!s || this.completed) return;
		this.completed = true;
		s.onComplete(s.results);
	}

	private renderMainContent(container: HTMLElement): void {
		const s = this.state!;
		const q = s.questions[s.currentIndex];
		if (!q) return;

		const result = s.results[s.currentIndex];
		const isAnswered = !!result;

		const questionCard = container.createDiv({ cls: "ap-pv-card" });

		const questionHeader = questionCard.createDiv({ cls: "ap-pv-question-header" });
		questionHeader.createEl("h2", {
			text: `Question ${s.currentIndex + 1}`,
			cls: "ap-pv-question-number",
		});

		const questionTextEl = questionCard.createDiv({ cls: "ap-pv-question-text" });
		this.renderMarkdown(q.questionText, questionTextEl);

		if (isAnswered) {
			this.renderAnsweredState(questionCard, container, q, result);
		} else {
			this.renderUnansweredState(questionCard, container, q);
		}
	}

	private renderUnansweredState(card: HTMLElement, container: HTMLElement, q: Question): void {
		this.selectedAnswer = "";
		this.hasChecked = false;
		this.questionStartTime = Date.now();

		if (q.type === "mcq" && q.options) {
			const selectLabel = card.createDiv({ cls: "ap-pv-select-label" });
			selectLabel.setText("Select your answer");

			const optionsGrid = card.createDiv({ cls: "ap-pv-options-grid" });
			this.renderMCQOptions(optionsGrid, q.options);
		} else {
			const inputLabel = card.createDiv({ cls: "ap-pv-select-label" });
			inputLabel.setText("Enter your answer below");

			const inputArea = card.createDiv({ cls: "ap-pv-input-area" });
			this.renderNumericInput(inputArea, q.type as "integer" | "decimal");
		}

		const btnRow = card.createDiv({ cls: "ap-pv-btn-row" });

		const skipBtn = btnRow.createEl("button", {
			text: "Skip",
			cls: "ap-pv-btn-skip",
		});
		skipBtn.addEventListener("click", () => {
			if (this.hasChecked) return;
			this.hasChecked = true;
			const elapsed = Date.now() - this.questionStartTime;
			this.state!.results[this.state!.currentIndex] = {
				question: q,
				userAnswer: "",
				isCorrect: false,
				skipped: true,
				timeTakenMs: elapsed,
			};
			adaptQuestionOrderForFlow(
				this.state!.questions,
				this.state!.results,
				this.state!.currentIndex
			);
			this.emitStateChange();
			this.render();
		});

		const checkBtn = btnRow.createEl("button", {
			text: "Check",
			cls: "ap-pv-btn-check",
		});
		checkBtn.addEventListener("click", () => {
			if (this.hasChecked) return;
			if (!this.selectedAnswer) return;

			this.hasChecked = true;
			const elapsed = Date.now() - this.questionStartTime;
			const isCorrect = checkAnswer(q, this.selectedAnswer);

			this.state!.results[this.state!.currentIndex] = {
				question: q,
				userAnswer: this.selectedAnswer,
				isCorrect,
				skipped: false,
				timeTakenMs: elapsed,
			};
			adaptQuestionOrderForFlow(
				this.state!.questions,
				this.state!.results,
				this.state!.currentIndex
			);
			this.emitStateChange();
			this.render();
		});

		this.installKeyHandler(q, card);
	}

	private renderAnsweredState(card: HTMLElement, container: HTMLElement, q: Question, result: QuizResult): void {
		if (q.type === "mcq" && q.options) {
			const selectLabel = card.createDiv({ cls: "ap-pv-select-label" });
			selectLabel.setText("Select your answer");

			const optionsGrid = card.createDiv({ cls: "ap-pv-options-grid" });
			this.renderMCQAnswered(optionsGrid, q, result);
		} else {
			const inputLabel = card.createDiv({ cls: "ap-pv-select-label" });
			inputLabel.setText("Enter your answer below");

			const inputArea = card.createDiv({ cls: "ap-pv-input-area" });
			const input = inputArea.createEl("input", {
				type: "text",
				cls: "ap-pv-numeric-input",
			});
			input.inputMode = q.type === "integer" ? "numeric" : "decimal";
			input.value = result.userAnswer || "";
			input.disabled = true;
			if (!result.skipped) {
				input.addClass(result.isCorrect ? "ap-pv-input-correct" : "ap-pv-input-incorrect");
			}
			if (!result.skipped && !result.isCorrect) {
				const clearIcon = inputArea.createDiv({ cls: "ap-pv-input-clear" });
				setIcon(clearIcon, "x");
			}
		}

		this.renderResultBanner(container, q, result);

		const solutionCard = container.createDiv({ cls: "ap-pv-card" });
		solutionCard.createEl("h3", { text: "Solution", cls: "ap-pv-solution-title" });
		const solutionContent = solutionCard.createDiv({ cls: "ap-pv-solution-content" });
		this.renderMarkdown(q.explanation, solutionContent);

		this.renderBottomBar(container, q, result);

		this.installAnsweredKeyHandler();
	}

	private renderResultBanner(container: HTMLElement, q: Question, result: QuizResult): void {
		const banner = container.createDiv({ cls: "ap-pv-result-banner" });

		const timeStr = formatTime(result.timeTakenMs);

		if (result.skipped) {
			banner.addClass("ap-pv-result-skipped");
			const left = banner.createDiv({ cls: "ap-pv-result-left" });
			const iconEl = left.createDiv({ cls: "ap-pv-result-icon ap-pv-icon-skipped" });
			setIcon(iconEl, "arrow-right");
			const textDiv = left.createDiv();
			textDiv.createEl("div", { text: "You skipped this question", cls: "ap-pv-result-title" });
			const metaLine = textDiv.createEl("div", { cls: "ap-pv-result-meta" });
			metaLine.createEl("span", {
				text: `Difficulty level: ${capitalize(q.difficulty)}`,
				cls: "ap-pv-result-difficulty",
			});

			const right = banner.createDiv({ cls: "ap-pv-result-right" });
			const timeEl = right.createDiv({ cls: "ap-pv-result-time" });
			setIcon(timeEl.createSpan(), "clock");
			timeEl.createSpan({ text: ` ${timeStr}` });
		} else if (result.isCorrect) {
			banner.addClass("ap-pv-result-correct");
			const left = banner.createDiv({ cls: "ap-pv-result-left" });
			const iconEl = left.createDiv({ cls: "ap-pv-result-icon ap-pv-icon-correct" });
			setIcon(iconEl, "check-circle");
			const textDiv = left.createDiv();
			textDiv.createEl("div", { text: "Your answer was correct", cls: "ap-pv-result-title ap-pv-text-correct" });
			const metaLine = textDiv.createEl("div", { cls: "ap-pv-result-meta" });
			metaLine.createEl("span", {
				text: `Difficulty level: ${capitalize(q.difficulty)}`,
				cls: "ap-pv-result-difficulty",
			});

			const right = banner.createDiv({ cls: "ap-pv-result-right" });
			const timeEl = right.createDiv({ cls: "ap-pv-result-time" });
			setIcon(timeEl.createSpan(), "clock");
			timeEl.createSpan({ text: ` ${timeStr}` });
		} else {
			banner.addClass("ap-pv-result-incorrect");
			const left = banner.createDiv({ cls: "ap-pv-result-left" });
			const iconEl = left.createDiv({ cls: "ap-pv-result-icon ap-pv-icon-incorrect" });
			setIcon(iconEl, "x-circle");
			const textDiv = left.createDiv();
			textDiv.createEl("div", { text: "Your answer was incorrect", cls: "ap-pv-result-title ap-pv-text-incorrect" });
			const metaLine = textDiv.createEl("div", { cls: "ap-pv-result-meta" });
			metaLine.createEl("span", {
				text: `Difficulty level: ${capitalize(q.difficulty)}`,
				cls: "ap-pv-result-difficulty",
			});

			const right = banner.createDiv({ cls: "ap-pv-result-right" });
			const timeEl = right.createDiv({ cls: "ap-pv-result-time" });
			setIcon(timeEl.createSpan(), "clock");
			timeEl.createSpan({ text: ` ${timeStr}` });
		}
	}

	private renderBottomBar(container: HTMLElement, q: Question, result: QuizResult): void {
		const bar = container.createDiv({ cls: "ap-pv-bottom-bar" });
		const s = this.state!;
		const currentIdx = s.currentIndex;
		const isSaved = this.savedIndices.has(currentIdx);

		const saveBtn = bar.createEl("button", { cls: "ap-pv-btn-save" });
		this.renderSaveButtonContent(saveBtn, isSaved);

		saveBtn.addEventListener("click", () => {
			void (async () => {
				if (saveBtn.disabled) return;
				saveBtn.disabled = true;

				if (this.savedIndices.has(currentIdx)) {
					try {
						await removeSingleQuestion(this.app, s.topics, result);
						this.savedIndices.delete(currentIdx);
						new Notice("Question removed from topic note.");
					} catch (e) {
						new Notice(`Failed to remove: ${e instanceof Error ? e.message : String(e)}`);
					}
				} else {
					try {
						await appendSingleQuestion(this.app, s.topics, result);
						this.savedIndices.add(currentIdx);
						new Notice("Question saved to topic note.");
					} catch (e) {
						new Notice(`Failed to save: ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				saveBtn.disabled = false;
				this.renderSaveButtonContent(saveBtn, this.savedIndices.has(currentIdx));
			})();
		});

		const isLast = s.currentIndex >= s.questions.length - 1;

		const nextBtn = bar.createEl("button", {
			text: isLast ? "See results" : "Next question",
			cls: "ap-pv-btn-next",
		});
		nextBtn.addEventListener("click", () => {
			if (isLast) {
				this.finishCompletedSession();
				this.leaf.detach();
			} else {
				s.currentIndex++;
				this.emitStateChange();
				this.render();
			}
		});
	}

	private emitStateChange(): void {
		const s = this.state;
		if (!s?.onStateChange) return;
		s.onStateChange(s.questions, s.results, s.currentIndex);
	}

	private renderSaveButtonContent(btn: HTMLElement, isSaved: boolean): void {
		btn.empty();
		if (isSaved) {
			btn.addClass("ap-pv-btn-saved");
			setIcon(btn.createSpan({ cls: "ap-pv-btn-icon" }), "bookmark-check");
			btn.createSpan({ text: "Saved" });
		} else {
			btn.removeClass("ap-pv-btn-saved");
			setIcon(btn.createSpan({ cls: "ap-pv-btn-icon" }), "bookmark");
			btn.createSpan({ text: "Save" });
		}
	}

	private renderMCQOptions(container: HTMLElement, options: string[]): void {
		const letters = ["A", "B", "C", "D"];
		for (let i = 0; i < options.length; i++) {
			const opt = options[i]!;
			const letter = letters[i] ?? String(i + 1);

			const optionEl = container.createDiv({ cls: "ap-pv-option" });
			if (hasBlockMarkdown(opt)) {
				optionEl.addClass("ap-pv-option-has-block");
				container.addClass("ap-pv-options-grid-has-block");
			}
			optionEl.addEventListener("click", () => {
				this.selectedAnswer = opt;
				container.querySelectorAll(".ap-pv-option").forEach((el) => {
					el.removeClass("ap-pv-option-selected");
				});
				optionEl.addClass("ap-pv-option-selected");
			});

			const letterBadge = optionEl.createDiv({ cls: "ap-pv-option-letter" });
			letterBadge.setText(letter);

			const textEl = optionEl.createDiv({ cls: "ap-pv-option-text" });
			this.renderMarkdown(opt, textEl);
		}
	}

	private renderMCQAnswered(container: HTMLElement, q: Question, result: QuizResult): void {
		const letters = ["A", "B", "C", "D"];
		const options = q.options ?? [];
		const wasAttempted = !result.skipped;

		for (let i = 0; i < options.length; i++) {
			const opt = options[i]!;
			const letter = letters[i] ?? String(i + 1);

			const optionEl = container.createDiv({ cls: "ap-pv-option ap-pv-option-disabled" });
			if (hasBlockMarkdown(opt)) {
				optionEl.addClass("ap-pv-option-has-block");
				container.addClass("ap-pv-options-grid-has-block");
			}

			const isCorrectOption = opt === q.correctAnswer;
			const isUserChoice = opt === result.userAnswer;

			if (isCorrectOption) {
				optionEl.addClass("ap-pv-option-correct");
			} else if (wasAttempted && isUserChoice && !result.isCorrect) {
				optionEl.addClass("ap-pv-option-wrong");
			}

			const letterBadge = optionEl.createDiv({ cls: "ap-pv-option-letter" });

			if (isCorrectOption) {
				letterBadge.addClass("ap-pv-letter-correct");
				setIcon(letterBadge, "check");
			} else if (wasAttempted && isUserChoice && !result.isCorrect) {
				letterBadge.addClass("ap-pv-letter-wrong");
				setIcon(letterBadge, "x");
			} else {
				letterBadge.setText(letter);
			}

			const textEl = optionEl.createDiv({ cls: "ap-pv-option-text" });
			this.renderMarkdown(opt, textEl);
		}
	}

	private renderNumericInput(container: HTMLElement, type: "integer" | "decimal"): void {
		const inputWrap = container.createDiv({ cls: "ap-pv-input-wrap" });
		const input = inputWrap.createEl("input", {
			type: "text",
			cls: "ap-pv-numeric-input",
			placeholder: "Type your answer here...",
		});
		if (type === "integer") {
			input.inputMode = "numeric";
		} else {
			input.inputMode = "decimal";
		}
		input.addEventListener("input", () => {
			this.selectedAnswer = input.value;
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && this.selectedAnswer) {
				e.preventDefault();
				const checkBtn = container.closest(".ap-pv-card")?.querySelector<HTMLButtonElement>(".ap-pv-btn-check");
				checkBtn?.click();
			}
		});
	}

	private renderMarkdown(md: string, el: HTMLElement): void {
		renderMarkdown(this.app, md, el, this.renderComponent, {
			sourcePath: this.state?.topics[0]?.path ?? "",
			hoverParent: this,
			onInternalLinkClick: () => this.emitStateChange(),
		});
	}

	private sessionTopicsForTitles(titles: string[]): TopicNote[] {
		const topics = this.state?.topics ?? [];
		return titles.map((title) =>
			topics.find((topic) => topic.title === title) ?? {
				path: "",
				title,
				skill: 0,
				isPdf: false,
			}
		);
	}
}

class TopicListModal extends Modal {
	private topics: TopicNote[];

	constructor(app: App, topics: TopicNote[]) {
		super(app);
		this.topics = topics;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ap-topic-list-modal");

		this.setTitle("Topics in this session");

		const list = contentEl.createDiv({ cls: "ap-topic-list-items" });
		for (const topic of this.topics) {
			const item = list.createEl("button", {
				text: topic.title,
				cls: "ap-topic-list-item",
			});
			item.disabled = !topic.path;
			item.addEventListener("click", () => {
				if (!topic.path) return;
				void this.app.workspace.openLinkText(topic.path, "", "tab");
				this.close();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function formatTime(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
