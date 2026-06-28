import {
	App,
	Component,
	ItemView,
	Modal,
	Notice,
	WorkspaceLeaf,
} from "obsidian";
import { Question, QuizResult, TopicNote } from "../types";
import { checkAnswer } from "../practice/grader";
import { adaptQuestionOrderForFlow } from "../practice/flow-navigation";
import { hasAnsweredEveryQuestion } from "../practice/results";
import { appendSingleQuestion, removeSingleQuestion } from "../notes/writer";
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

type PracticeReaction = "good" | "better";
type QuestionReaction = "yes" | "no";
type ChoiceBadgeIcon = "check" | "x";
type StatusTone = "correct" | "wrong" | "skipped";

const MAX_VISIBLE_TOPICS = 3;
const OPTION_LETTERS = ["A", "B", "C", "D"];
const SKIP_REASONS = [
	{ label: "Difficult\nQuestion", icon: "thinking" },
	{ label: "Didn't\nUnderstand", icon: "confused" },
	{ label: "Haven't\nstudied", icon: "exclamation" },
] as const;
const CORRECT_STATUS_ICON_SVG = `
<svg class="ap-status-correct-svg" width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
	<circle cx="32.0003" cy="31.9997" r="21.3333" class="ap-status-fill-green"/>
	<mask id="ap-status-correct-mask-a" mask-type="alpha" maskUnits="userSpaceOnUse" x="10" y="10" width="44" height="44">
		<circle cx="32.0003" cy="31.9997" r="21.3333" class="ap-status-mask-fill"/>
	</mask>
	<g mask="url(#ap-status-correct-mask-a)">
		<g class="ap-status-soft-light">
			<circle cx="21.1523" cy="23.1728" r="15.7255" class="ap-status-fill-green-soft"/>
		</g>
	</g>
	<circle cx="51.2" cy="10.6664" r="3.2" class="ap-status-fill-green"/>
	<circle cx="55.4671" cy="16.0003" r="1.06667" class="ap-status-fill-blue"/>
	<circle cx="7.99967" cy="18.6667" r="2.66667" class="ap-status-fill-blue"/>
	<path d="M5.44877 52.7219C6.32285 51.2068 9.01374 48.3421 12.7847 49.0039" class="ap-status-stroke-red-soft" stroke-width="1.06667" stroke-linecap="round" stroke-linejoin="round"/>
	<circle cx="58.1332" cy="46.4" r="1.6" class="ap-status-fill-red-soft"/>
	<circle cx="23.9997" cy="56.0003" r="2.66667" class="ap-status-fill-yellow"/>
	<path d="M21.8672 33.0669L28.8005 39.4669L43.7339 24.5336" class="ap-status-stroke-on-accent" stroke-width="3.2"/>
	<path d="M47.334 52.9968L48.4089 55.6631C48.946 56.9954 50.3364 57.7759 51.7535 57.5406V57.5406C53.1706 57.3052 54.561 58.0857 55.0981 59.418L55.5748 60.6003" class="ap-status-stroke-blue" stroke-width="1.06667" stroke-linecap="round" stroke-linejoin="round"/>
	<path d="M13.8672 3.19995C14.0786 4.27606 14.3738 6.61666 15.439 7.67995C15.8139 8.05425 17.0108 8.63995 17.6395 8.63995C19.2113 8.63995 19.5256 7.03995 18.8969 6.07995C18.2682 5.11995 16.3821 5.43995 16.0677 7.03995C15.7533 8.63995 16.0677 11.2 18.5826 12.8" class="ap-status-stroke-orange" stroke-width="1.06667" stroke-linecap="round" stroke-linejoin="round"/>
	<circle cx="32" cy="32" r="20" class="ap-status-fill-green"/>
	<mask id="ap-status-correct-mask-b" mask-type="alpha" maskUnits="userSpaceOnUse" x="12" y="12" width="40" height="40">
		<circle cx="32" cy="32" r="20" class="ap-status-mask-fill"/>
	</mask>
	<g mask="url(#ap-status-correct-mask-b)">
		<g class="ap-status-soft-light">
			<circle cx="20.7427" cy="14.7427" r="14.7427" class="ap-status-highlight"/>
		</g>
	</g>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M43.0733 26.0475L28.3832 41.1048L20.9688 34.0896L23.0306 31.9104L28.299 36.8952L40.926 23.9525L43.0733 26.0475Z" class="ap-status-fill-on-accent"/>
	<circle cx="54.5" cy="10.5" r="2.5" class="ap-status-fill-blue"/>
	<circle cx="11" cy="50" r="2" class="ap-status-fill-green"/>
	<circle cx="56.5" cy="33.5" r="1.5" class="ap-status-fill-blue"/>
	<circle cx="56.5" cy="48.5" r="1.5" class="ap-status-fill-green"/>
	<circle cx="39" cy="8" r="1" class="ap-status-fill-red"/>
	<path d="M7.28512 22.8206L8.26844 24.8305C8.45473 25.2113 9.00062 25.2021 9.17389 24.8152L10.3449 22.2005C10.5182 21.8136 10.1616 21.4001 9.75346 21.5147L7.59912 22.1195C7.29849 22.2038 7.1479 22.5401 7.28512 22.8206Z" class="ap-status-fill-red"/>
	<path d="M44.2682 56.0476L42.0553 55.7159C41.6361 55.653 41.3338 56.1077 41.5539 56.47L43.0414 58.9185C43.2615 59.2808 43.8043 59.222 43.9417 58.8209L44.6671 56.7042C44.7683 56.4088 44.577 56.0939 44.2682 56.0476Z" class="ap-status-fill-orange"/>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M3.85823 9.64293C4.11244 9.53509 4.40594 9.65376 4.51378 9.90798C4.80251 10.5887 5.39412 11.475 6.20015 11.9637C6.59457 12.2028 7.03304 12.3429 7.51638 12.3291C7.5374 12.3285 7.55858 12.3276 7.57992 12.3264C7.19283 11.5935 7.04212 10.7538 7.25348 9.89103C7.46471 9.02881 8.0106 8.50924 8.67806 8.33791C9.3132 8.17487 9.99542 8.34313 10.4999 8.70613C11.0113 9.07418 11.3934 9.68562 11.3148 10.4307C11.2376 11.1639 10.7287 11.8863 9.77482 12.534C9.60157 12.6517 9.42975 12.7554 9.2595 12.8457C10.0012 13.4922 11.0433 13.9157 12.1574 13.9157C12.4336 13.9157 12.6574 14.1395 12.6574 14.4157C12.6574 14.6918 12.4336 14.9157 12.1574 14.9157C10.6936 14.9157 9.3271 14.3204 8.39455 13.4076C8.33839 13.3526 8.28369 13.2963 8.23053 13.2388C7.99805 13.2928 7.7694 13.3222 7.54498 13.3286C6.83923 13.3488 6.21312 13.1409 5.68175 12.8188C4.6362 12.185 3.9314 11.0959 3.59317 10.2985C3.48534 10.0443 3.60401 9.75076 3.85823 9.64293ZM8.58244 12.0651C8.78324 11.9738 8.99345 11.8558 9.21304 11.7067C10.0389 11.1459 10.2861 10.6512 10.3204 10.3259C10.3534 10.0126 10.2025 9.72414 9.91575 9.51781C9.62202 9.30644 9.24086 9.22586 8.92669 9.30651C8.64483 9.37886 8.35545 9.59549 8.22476 10.129C8.06276 10.7903 8.20317 11.4646 8.58244 12.0651Z" class="ap-status-fill-green"/>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M47.8352 51.1007C47.8585 51.3759 48.1005 51.58 48.3757 51.5566C49.1161 51.4937 50.1845 51.5903 51.0049 52.041C51.4035 52.2599 51.7314 52.5553 51.9472 52.9469C51.1359 52.9575 50.3434 53.2029 49.6962 53.7502C49.0357 54.3085 48.8267 55.0079 49.0044 55.6615C49.171 56.2745 49.6549 56.7624 50.2079 57.0141C50.7678 57.2689 51.4754 57.3144 52.0873 56.924C52.6993 56.5335 53.0967 55.7833 53.2091 54.697C53.2281 54.5136 53.237 54.3365 53.2362 54.1657C54.1679 54.4923 55.0397 55.1659 55.5706 56.0769C55.7097 56.3155 56.0158 56.3961 56.2544 56.2571C56.4929 56.118 56.5736 55.8119 56.4346 55.5733C55.7277 54.3605 54.5479 53.5013 53.3084 53.1389C53.2329 53.1168 53.157 53.0965 53.0807 53.0781C53.0162 52.8649 52.9324 52.6652 52.8311 52.4789C52.5064 51.8821 52.0207 51.458 51.4864 51.1645C50.4342 50.5866 49.1479 50.4874 48.291 50.5602C48.0159 50.5836 47.8118 50.8256 47.8352 51.1007ZM52.2282 53.9535C52.242 54.1484 52.2386 54.3613 52.2145 54.594C52.1202 55.5048 51.8125 55.9131 51.5494 56.081C51.2863 56.2489 50.9489 56.2526 50.6221 56.1039C50.2885 55.9521 50.0442 55.6748 49.9694 55.3993C49.9055 55.1644 49.9418 54.852 50.3418 54.5138C50.8449 54.0884 51.5105 53.9048 52.2282 53.9535Z" class="ap-status-fill-red"/>
	<path d="M11.1016 32C11.6164 32.8231 12.2667 33.5532 13.0249 34.1595L14.2033 35.1017L12.8369 36.1259C12.1051 36.6744 11.511 37.3857 11.1016 38.2035C10.6921 37.3857 10.098 36.6744 9.36623 36.1259L7.99983 35.1017L9.36623 34.0776C10.098 33.5291 10.6921 32.8178 11.1016 32Z" class="ap-status-fill-blue"/>
	<path d="M49.9746 39C50.6343 40.0547 51.4676 40.9903 52.4392 41.7672L53.9492 42.9746L52.1983 44.2869C51.2605 44.9898 50.4992 45.9012 49.9746 46.9491C49.45 45.9012 48.6887 44.9898 47.751 44.2869L46 42.9746L47.7509 41.6622C48.6887 40.9593 49.45 40.0479 49.9746 39Z" class="ap-status-fill-orange"/>
</svg>
`;
const WRONG_STATUS_ICON_SVG = `
<svg class="ap-status-wrong-svg" width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
	<circle cx="41.5" cy="7.5" r="1.5" class="ap-status-fill-red"/>
	<circle cx="5" cy="30" r="1" class="ap-status-fill-red"/>
	<circle cx="55" cy="39" r="1" class="ap-status-fill-red"/>
	<circle cx="41" cy="53" r="2" class="ap-status-fill-red"/>
	<circle cx="30" cy="30" r="20" class="ap-status-fill-red"/>
	<mask id="ap-status-wrong-mask" mask-type="alpha" maskUnits="userSpaceOnUse" x="10" y="10" width="40" height="40">
		<circle cx="30" cy="30" r="20" class="ap-status-mask-fill"/>
	</mask>
	<g mask="url(#ap-status-wrong-mask)">
		<g class="ap-status-soft-light">
			<circle cx="18.7427" cy="12.7427" r="14.7427" class="ap-status-highlight"/>
		</g>
	</g>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M38.0608 24.0607L24.0608 38.0607L21.9395 35.9393L35.9395 21.9393L38.0608 24.0607Z" class="ap-status-fill-on-accent"/>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M21.9392 24.0607L35.9392 38.0607L38.0605 35.9393L24.0605 21.9393L21.9392 24.0607Z" class="ap-status-fill-on-accent"/>
	<path d="M50.8633 54.6573L51.419 51.7093L47.9796 51.0609L48.5353 48.1128L45.5873 47.5571" class="ap-status-stroke-red"/>
	<path d="M5.43262 8.28906L6.24097 11.1781L9.61152 10.235L10.4199 13.1241L13.3089 12.3157" class="ap-status-stroke-red"/>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M52.1415 14.7703L47.9902 10.619L48.6192 9.98999L52.7705 14.1413L52.1415 14.7703Z" class="ap-status-fill-red"/>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M52.1415 9.98994L47.9902 14.1412L48.6192 14.7703L52.7705 10.619L52.1415 9.98994Z" class="ap-status-fill-red"/>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M11.9158 47.5569L8.96218 50.5105L8.51465 50.0629L11.4682 47.1094L11.9158 47.5569Z" class="ap-status-fill-red"/>
	<path fill-rule="evenodd" clip-rule="evenodd" d="M8.51491 47.5569L11.4685 50.5105L11.916 50.0629L8.96244 47.1094L8.51491 47.5569Z" class="ap-status-fill-red"/>
</svg>
`;
const SKIPPED_STATUS_ICON_SVG = `
<svg class="ap-status-skipped-svg" width="60" height="60" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
	<circle cx="30" cy="30" r="20" class="ap-status-fill-text-muted"/>
	<mask id="ap-status-skipped-mask" mask-type="alpha" maskUnits="userSpaceOnUse" x="10" y="10" width="40" height="40">
		<circle cx="30" cy="30" r="20" class="ap-status-mask-fill"/>
	</mask>
	<g mask="url(#ap-status-skipped-mask)">
		<g class="ap-status-soft-light">
			<circle cx="18.7427" cy="12.7427" r="14.7427" class="ap-status-highlight"/>
		</g>
	</g>
	<path d="M25.6757 22.4434L34.6866 30.6866L25.7716 38.8249" class="ap-status-stroke-on-accent" stroke-width="3"/>
</svg>
`;

export class PracticeView extends ItemView {
	private state: PracticeState | null = null;
	private renderComponent: Component;
	private selectedAnswer = "";
	private hasChecked = false;
	private questionStartTime = 0;
	private keyHandler: ((e: KeyboardEvent) => void) | null = null;
	private timerId: number | null = null;
	private savedIndices = new Set<number>();
	private completed = false;
	private activeSkipOverlay: HTMLElement | null = null;
	private activeCompletionOverlay: HTMLElement | null = null;
	private questionReactions = new Map<number, QuestionReaction>();
	private practiceReaction: PracticeReaction | null = null;
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
		this.selectedAnswer = "";
		this.hasChecked = false;
		this.savedIndices.clear();
		this.questionReactions.clear();
		this.practiceReaction = null;
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
		this.stopTimer();
		this.renderComponent.unload();
		this.contentEl.empty();
	}

	private render(): void {
		this.removeKeyHandler();
		this.stopTimer();
		this.activeSkipOverlay = null;
		this.activeCompletionOverlay = null;

		if (!this.state) return;
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ap-practice-view");

		this.renderTopbar(contentEl);

		const body = contentEl.createDiv({ cls: "ap-practice-body" });
		if (this.state.questionPaneSide === "right") body.addClass("ap-practice-body-reversed");

		const sidebar = body.createDiv({ cls: "ap-practice-rail" });
		const stage = body.createDiv({ cls: "ap-practice-stage" });

		this.renderSidebar(sidebar);
		this.renderMainContent(stage);
	}

	private renderTopbar(container: HTMLElement): void {
		const topbar = container.createDiv({ cls: "ap-practice-topbar" });
		const inner = topbar.createDiv({ cls: "ap-practice-topbar-inner" });
		inner.createDiv({ text: "Adaptive Practice", cls: "ap-practice-brand" });

		const endBtn = inner.createEl("button", {
			text: "End practice",
			cls: "ap-end-practice-button",
		});
		endBtn.addEventListener("click", () => this.handleEndPractice());
	}

	private handleEndPractice(): void {
		if (this.hasAnsweredAllQuestions()) {
			this.openCompletionDialog();
			return;
		}

		this.emitStateChange();
		new Notice("Practice session saved.");
		void this.leaf.detach();
	}

	private renderSidebar(container: HTMLElement): void {
		const s = this.state!;
		const header = container.createDiv({ cls: "ap-practice-rail-header" });
		header.createDiv({ text: "Practice", cls: "ap-practice-rail-title" });

		const topicNames = [...new Set(s.questions.flatMap((q) => q.sourceTopics))];
		if (topicNames.length > 0) {
			const topic = header.createDiv({ cls: "ap-practice-rail-topic" });
			if (topicNames.length <= MAX_VISIBLE_TOPICS) {
				topic.setText(topicNames.join(", "));
			} else {
				topic.addClass("ap-practice-topic-clickable");
				topic.setText(`${topicNames.slice(0, MAX_VISIBLE_TOPICS).join(", ")} +${topicNames.length - MAX_VISIBLE_TOPICS} more`);
				topic.addEventListener("click", () => {
					new TopicListModal(this.app, this.sessionTopicsForTitles(topicNames)).open();
				});
			}
		}

		const grid = container.createDiv({ cls: "ap-practice-navigator" });
		const furthestReachable = this.getFurthestReachableIndex();

		for (let i = 0; i < s.questions.length; i++) {
			const cell = grid.createEl("button", { text: `${i + 1}`, cls: "ap-nav-cell" });
			const result = s.results[i];
			if (result) {
				if (result.skipped) {
					cell.addClass("is-skipped");
				} else if (result.isCorrect) {
					cell.addClass("is-correct");
				} else {
					cell.addClass("is-wrong");
				}
			}

			if (i === s.currentIndex) cell.addClass("is-current");
			if (i <= furthestReachable) {
				cell.addClass("is-reachable");
				cell.addEventListener("click", () => {
					s.currentIndex = i;
					this.emitStateChange();
					this.render();
				});
			} else {
				cell.disabled = true;
			}
		}

		const stats = container.createDiv({ cls: "ap-practice-stats" });
		this.renderStat(stats, "Right answers", `${s.results.filter((r) => r.isCorrect).length}`);
		this.renderStat(stats, "Wrong answers", `${s.results.filter((r) => !r.isCorrect && !r.skipped).length}`);
		this.renderStat(stats, "Skipped", `${s.results.filter((r) => r.skipped).length}`);
	}

	private renderStat(container: HTMLElement, label: string, value: string): void {
		const row = container.createDiv({ cls: "ap-practice-stat" });
		row.createSpan({ text: label, cls: "ap-practice-stat-label" });
		row.createSpan({ text: value, cls: "ap-practice-stat-value" });
	}

	private renderMainContent(stage: HTMLElement): void {
		const s = this.state!;
		const q = s.questions[s.currentIndex];
		if (!q) return;

		const result = s.results[s.currentIndex];
		const questionPaper = stage.createDiv({ cls: "ap-question-paper" });
		this.renderQuestionHeader(questionPaper, q, result ?? null);
		this.renderQuestionText(questionPaper, q);

		if (result) {
			this.renderAnsweredQuestion(questionPaper, stage, q, result);
			this.installAnsweredKeyHandler();
		} else {
			this.renderUnansweredQuestion(questionPaper, stage, q);
			this.installKeyHandler(q, questionPaper);
		}
	}

	private renderQuestionHeader(container: HTMLElement, q: Question, result: QuizResult | null): void {
		const s = this.state!;
		const header = container.createDiv({ cls: "ap-question-header" });
		header.createEl("h2", {
			text: `Question ${s.currentIndex + 1}`,
			cls: "ap-question-title",
		});

		const timer = header.createDiv({ cls: "ap-question-timer" });
		timer.createSpan({ cls: "ap-question-timer-icon ap-icon-stopwatch" });
		const timerText = timer.createSpan({ cls: "ap-question-timer-text" });
		if (result) {
			timerText.setText(formatClock(result.timeTakenMs));
		} else {
			this.questionStartTime = Date.now();
			timerText.setText("00:00");
			this.startTimer(timerText);
		}

		if (q.difficulty === "hard") {
			header.addClass("is-hard-question");
		}
	}

	private renderQuestionText(container: HTMLElement, q: Question): void {
		const questionText = container.createDiv({ cls: "ap-question-copy ap-redesign-markdown" });
		this.renderMarkdown(q.questionText, questionText);
	}

	private renderUnansweredQuestion(card: HTMLElement, stage: HTMLElement, q: Question): void {
		this.selectedAnswer = "";
		this.hasChecked = false;
		this.renderAnswerArea(card, q, null);

		const actionBar = this.renderActionBar(stage);
		const skipBtn = actionBar.createEl("button", {
			text: "Skip",
			cls: "ap-secondary-action ap-skip-button",
		});
		skipBtn.addEventListener("click", () => {
			if (this.hasChecked) return;
			this.openSkipDialog();
		});

		const submitBtn = actionBar.createEl("button", {
			text: "Submit",
			cls: "ap-primary-action ap-submit-button",
		});
		submitBtn.disabled = true;
		submitBtn.addEventListener("click", () => {
			if (this.hasChecked || !this.selectedAnswer) return;
			this.submitCurrentAnswer(q);
		});
	}

	private renderAnsweredQuestion(
		card: HTMLElement,
		stage: HTMLElement,
		q: Question,
		result: QuizResult
	): void {
		this.renderAnswerArea(card, q, result);
		this.renderResultPaper(stage, q, result);

		const actionBar = this.renderActionBar(stage);
		const currentIdx = this.state!.currentIndex;
		const saveBtn = actionBar.createEl("button", { cls: "ap-secondary-action ap-save-button" });
		this.renderSaveButtonContent(saveBtn, this.savedIndices.has(currentIdx));
		saveBtn.addEventListener("click", () => {
			void this.toggleSavedQuestion(saveBtn, currentIdx, result);
		});

		const isLast = this.state!.currentIndex >= this.state!.questions.length - 1;
		const nextBtn = actionBar.createEl("button", {
			text: isLast ? "Finish practice" : "Next question",
			cls: "ap-primary-action ap-next-button",
		});
		nextBtn.addEventListener("click", () => {
			if (isLast) {
				this.openCompletionDialog();
				return;
			}
			this.state!.currentIndex++;
			this.emitStateChange();
			this.render();
		});
	}

	private renderAnswerArea(container: HTMLElement, q: Question, result: QuizResult | null): void {
		container.createDiv({ text: "Select your answer", cls: "ap-answer-label" });
		if (q.type === "mcq" && q.options) {
			const grid = container.createDiv({ cls: "ap-choice-grid" });
			if (q.options.some(hasBlockMarkdown)) grid.addClass("has-block-options");
			if (result) {
				this.renderAnsweredChoices(grid, q, result);
			} else {
				this.renderChoiceOptions(grid, q.options);
			}
			return;
		}

		this.renderNumericAnswer(container, q, result);
	}

	private renderChoiceOptions(container: HTMLElement, options: string[]): void {
		for (let i = 0; i < options.length; i++) {
			const option = options[i]!;
			const choice = container.createDiv({ cls: "ap-choice" });
			if (hasBlockMarkdown(option)) choice.addClass("has-block-content");
			choice.addEventListener("click", () => {
				this.selectedAnswer = option;
				container.querySelectorAll(".ap-choice").forEach((el) => el.removeClass("is-selected"));
				choice.addClass("is-selected");
				this.updateSubmitButton();
			});

			this.renderChoiceBadge(choice, OPTION_LETTERS[i] ?? String(i + 1));
			const text = choice.createDiv({ cls: "ap-choice-text ap-redesign-markdown" });
			this.renderMarkdown(option, text);
		}
	}

	private renderAnsweredChoices(container: HTMLElement, q: Question, result: QuizResult): void {
		const options = q.options ?? [];
		const wasAttempted = !result.skipped;

		for (let i = 0; i < options.length; i++) {
			const option = options[i]!;
			const isCorrectOption = option === q.correctAnswer;
			const isUserChoice = option === result.userAnswer;
			const choice = container.createDiv({ cls: "ap-choice is-locked" });
			if (hasBlockMarkdown(option)) choice.addClass("has-block-content");

			if (isCorrectOption) {
				choice.addClass("is-correct");
				this.renderChoiceBadge(choice, "", "check");
			} else if (wasAttempted && isUserChoice && !result.isCorrect) {
				choice.addClass("is-wrong");
				this.renderChoiceBadge(choice, "", "x");
			} else {
				this.renderChoiceBadge(choice, OPTION_LETTERS[i] ?? String(i + 1));
			}

			const text = choice.createDiv({ cls: "ap-choice-text ap-redesign-markdown" });
			this.renderMarkdown(option, text);
		}
	}

	private renderChoiceBadge(container: HTMLElement, text: string, icon?: ChoiceBadgeIcon): void {
		const badge = container.createDiv({ cls: "ap-choice-badge" });
		if (icon) {
			badge.addClass("has-icon");
			badge.createSpan({ cls: `ap-choice-symbol ap-choice-symbol-${icon}` });
		} else {
			badge.setText(text);
		}
	}

	private renderNumericAnswer(container: HTMLElement, q: Question, result: QuizResult | null): void {
		const wrap = container.createDiv({ cls: "ap-numeric-answer" });
		const input = wrap.createEl("input", {
			type: "text",
			cls: "ap-numeric-answer-input",
			placeholder: "Type your answer",
		});
		input.inputMode = q.type === "integer" ? "numeric" : "decimal";

		if (result) {
			input.value = result.userAnswer;
			input.disabled = true;
			if (!result.skipped) input.addClass(result.isCorrect ? "is-correct" : "is-wrong");
			return;
		}

		input.addEventListener("input", () => {
			this.selectedAnswer = input.value;
			this.updateSubmitButton();
		});
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && this.selectedAnswer) {
				e.preventDefault();
				this.submitCurrentAnswer(q);
			}
		});
	}

	private renderResultPaper(stage: HTMLElement, q: Question, result: QuizResult): void {
		const paper = stage.createDiv({ cls: "ap-result-paper" });
		paper.createEl("h3", { text: "Result", cls: "ap-result-heading" });
		this.renderStatusBox(paper, q, result);

		paper.createEl("h3", { text: "Solution", cls: "ap-solution-heading" });
		const solution = paper.createDiv({ cls: "ap-solution-copy ap-redesign-markdown" });
		this.renderMarkdown(q.explanation, solution);

		this.renderQuestionReaction(paper);
	}

	private renderStatusBox(container: HTMLElement, q: Question, result: QuizResult): void {
		const status = container.createDiv({ cls: "ap-status-box" });
		const tone: StatusTone = result.skipped ? "skipped" : result.isCorrect ? "correct" : "wrong";
		status.addClass(`is-${tone}`);

		const left = status.createDiv({ cls: "ap-status-left" });
		const icon = left.createDiv({ cls: "ap-status-icon" });
		this.renderStatusIcon(icon, tone);

		const copy = left.createDiv({ cls: "ap-status-copy" });
		copy.createDiv({
			text: result.skipped
				? "You skipped this question"
				: result.isCorrect
					? "Your answer was correct"
					: "Your answer was incorrect",
			cls: "ap-status-title",
		});
		copy.createDiv({
			text: `Difficulty level: ${difficultyLabel(q.difficulty)}`,
			cls: "ap-status-subtitle",
		});

		const right = status.createDiv({ cls: "ap-status-time" });
		const timeLine = right.createDiv({ cls: "ap-status-time-primary" });
		timeLine.createSpan({ cls: "ap-status-time-icon ap-icon-stopwatch" });
		timeLine.createSpan({ text: formatShortTime(result.timeTakenMs) });
	}

	private renderStatusIcon(container: HTMLElement, tone: StatusTone): void {
		const icon = container.createSpan({ cls: `ap-status-asset ap-status-asset-${tone}` });
		icon.setAttr("aria-hidden", "true");
		if (tone === "correct") {
			const parsed = new DOMParser().parseFromString(CORRECT_STATUS_ICON_SVG, "image/svg+xml");
			icon.appendChild(document.importNode(parsed.documentElement, true));
		} else if (tone === "wrong") {
			const parsed = new DOMParser().parseFromString(WRONG_STATUS_ICON_SVG, "image/svg+xml");
			icon.appendChild(document.importNode(parsed.documentElement, true));
		} else {
			const parsed = new DOMParser().parseFromString(SKIPPED_STATUS_ICON_SVG, "image/svg+xml");
			icon.appendChild(document.importNode(parsed.documentElement, true));
		}
	}

	private renderQuestionReaction(container: HTMLElement): void {
		const divider = container.createDiv({ cls: "ap-solution-divider" });
		divider.setAttr("aria-hidden", "true");

		const currentIndex = this.state!.currentIndex;
		const selected = this.questionReactions.get(currentIndex);
		const feedback = container.createDiv({ cls: "ap-question-feedback" });
		feedback.createDiv({ text: "Did you like this question?", cls: "ap-question-feedback-title" });

		const buttons = feedback.createDiv({ cls: "ap-question-feedback-buttons" });
		const yes = this.renderThumbButton(buttons, "Yes", "thumbs-up", selected === "yes");
		const no = this.renderThumbButton(buttons, "No", "thumbs-down", selected === "no");

		yes.addEventListener("click", () => {
			this.questionReactions.set(currentIndex, "yes");
			this.render();
		});
		no.addEventListener("click", () => {
			this.questionReactions.set(currentIndex, "no");
			this.render();
		});
	}

	private renderThumbButton(
		container: HTMLElement,
		label: string,
		iconName: string,
		active: boolean
	): HTMLButtonElement {
		const wrap = container.createDiv({ cls: "ap-thumb-choice" });
		const button = wrap.createEl("button", { cls: "ap-thumb-button" });
		if (active) button.addClass("is-active");
		button.createSpan({ cls: `ap-thumb-glyph ap-thumb-glyph-${iconName === "thumbs-up" ? "up" : "down"}` });
		wrap.createDiv({ text: label, cls: "ap-thumb-label" });
		return button;
	}

	private renderActionBar(stage: HTMLElement): HTMLElement {
		return stage.createDiv({ cls: "ap-action-bar" });
	}

	private updateSubmitButton(): void {
		const submit = this.contentEl.querySelector<HTMLButtonElement>(".ap-submit-button");
		if (!submit) return;
		submit.disabled = !this.selectedAnswer.trim();
	}

	private renderSaveButtonContent(button: HTMLElement, isSaved: boolean): void {
		button.empty();
		button.toggleClass("is-saved", isSaved);
		button.createSpan({ text: isSaved ? "Saved" : "Save" });
	}

	private async toggleSavedQuestion(button: HTMLButtonElement, index: number, result: QuizResult): Promise<void> {
		if (!this.state || button.disabled) return;
		button.disabled = true;

		try {
			if (this.savedIndices.has(index)) {
				await removeSingleQuestion(this.app, this.state.topics, result);
				this.savedIndices.delete(index);
				new Notice("Question removed from topic note.");
			} else {
				await appendSingleQuestion(this.app, this.state.topics, result);
				this.savedIndices.add(index);
				new Notice("Question saved to topic note.");
			}
			this.renderSaveButtonContent(button, this.savedIndices.has(index));
		} catch (error) {
			const action = this.savedIndices.has(index) ? "remove" : "save";
			new Notice(`Failed to ${action}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			button.disabled = false;
		}
	}

	private submitCurrentAnswer(q: Question): void {
		if (this.hasChecked) return;
		if (!this.selectedAnswer.trim()) return;
		this.recordResult(q, this.selectedAnswer, false);
	}

	private skipCurrentQuestion(reason?: string): void {
		const q = this.state?.questions[this.state.currentIndex];
		if (!q || this.hasChecked) return;
		this.closeSkipDialog();
		this.recordResult(q, reason ? `Skipped: ${reason.replace(/\n/g, " ")}` : "", true);
	}

	private recordResult(q: Question, answer: string, skipped: boolean): void {
		if (!this.state) return;
		this.hasChecked = true;
		const elapsed = Date.now() - this.questionStartTime;
		const isCorrect = !skipped && checkAnswer(q, answer);

		this.state.results[this.state.currentIndex] = {
			question: q,
			userAnswer: skipped ? "" : answer,
			isCorrect,
			skipped,
			timeTakenMs: elapsed,
		};
		adaptQuestionOrderForFlow(
			this.state.questions,
			this.state.results,
			this.state.currentIndex
		);
		this.emitStateChange();
		this.render();
	}

	private openSkipDialog(): void {
		if (this.activeSkipOverlay) return;

		const overlay = this.contentEl.createDiv({ cls: "ap-practice-overlay ap-skip-overlay" });
		this.activeSkipOverlay = overlay;
		overlay.addEventListener("click", (event) => {
			if (event.target === overlay) this.closeSkipDialog();
		});

		const dialog = overlay.createDiv({ cls: "ap-skip-dialog" });
		const close = dialog.createEl("button", { cls: "ap-dialog-close" });
		close.setAttr("aria-label", "Close");
		close.createSpan({ cls: "ap-dialog-close-icon" });
		close.addEventListener("click", () => this.closeSkipDialog());

		dialog.createEl("h2", {
			text: "Why do you need to skip?",
			cls: "ap-skip-title",
		});

		const reasons = dialog.createDiv({ cls: "ap-skip-reasons" });
		for (const reason of SKIP_REASONS) {
			const button = reasons.createEl("button", { cls: "ap-skip-reason" });
			button.createSpan({ cls: `ap-skip-reason-icon ap-skip-reason-icon-${reason.icon}` });
			button.createSpan({ text: reason.label, cls: "ap-skip-reason-label" });
			button.addEventListener("click", () => this.skipCurrentQuestion(reason.label));
		}
	}

	private closeSkipDialog(): void {
		this.activeSkipOverlay?.remove();
		this.activeSkipOverlay = null;
	}

	private openCompletionDialog(): void {
		if (!this.state || this.activeCompletionOverlay) return;

		const overlay = this.contentEl.createDiv({ cls: "ap-practice-overlay ap-completion-overlay" });
		this.activeCompletionOverlay = overlay;

		const dialog = overlay.createDiv({ cls: "ap-completion-dialog" });
		dialog.createEl("h2", { text: "Practice complete", cls: "ap-completion-title" });
		dialog.createDiv({ text: this.topicSummary(), cls: "ap-completion-topic" });

		const metrics = dialog.createDiv({ cls: "ap-completion-metrics" });
		this.renderCompletionMetric(metrics, "AVG TIME PER ATTEMPT", averageAttemptTime(this.state.results), "timer");
		this.renderCompletionMetric(metrics, "CORRECT ANSWERS", `${this.state.results.filter((r) => r.isCorrect).length} out of ${this.state.questions.length}`, "award");

		dialog.createDiv({
			text: "How was your practice experience?",
			cls: "ap-practice-feedback-title",
		});
		const reactions = dialog.createDiv({ cls: "ap-practice-feedback-buttons" });
		this.renderPracticeReaction(reactions, "Was good", "thumbs-up", "good");
		this.renderPracticeReaction(reactions, "Can be better", "thumbs-down", "better");

		const wrongCount = this.state.results.filter((r) => !r.isCorrect && !r.skipped).length;
		const wrongLine = dialog.createDiv({ cls: "ap-completion-wrong-line" });
		wrongLine.createSpan({ text: "You got " });
		wrongLine.createSpan({
			text: `${wrongCount} ${wrongCount === 1 ? "question" : "questions"} incorrect`,
			cls: "ap-completion-wrong-count",
		});
		wrongLine.createSpan({ text: " in this practice" });

		const actions = dialog.createDiv({ cls: "ap-completion-actions" });
		const later = actions.createEl("button", { text: "Practice later", cls: "ap-secondary-action" });
		const now = actions.createEl("button", { text: "Practice now", cls: "ap-primary-action" });
		later.addEventListener("click", () => this.completeAndClose());
		now.addEventListener("click", () => this.completeAndClose());
	}

	private renderCompletionMetric(
		container: HTMLElement,
		label: string,
		value: string,
		iconName: string
	): void {
		const card = container.createDiv({ cls: "ap-completion-metric" });
		const icon = card.createDiv({ cls: "ap-completion-metric-icon" });
		icon.createSpan({ cls: `ap-completion-metric-glyph ap-completion-metric-glyph-${iconName}` });
		card.createDiv({ text: label, cls: "ap-completion-metric-label" });
		card.createDiv({ text: value, cls: "ap-completion-metric-value" });
	}

	private renderPracticeReaction(
		container: HTMLElement,
		label: string,
		iconName: string,
		reaction: PracticeReaction
	): void {
		const button = container.createEl("button", { cls: "ap-practice-feedback-button" });
		if (this.practiceReaction === reaction) button.addClass("is-active");
		button.createSpan({ cls: `ap-thumb-glyph ap-thumb-glyph-${iconName === "thumbs-up" ? "up" : "down"}` });
		button.createSpan({ text: label });
		button.addEventListener("click", () => {
			this.practiceReaction = reaction;
			container.querySelectorAll(".ap-practice-feedback-button").forEach((el) => el.removeClass("is-active"));
			button.addClass("is-active");
		});
	}

	private completeAndClose(): void {
		this.activeCompletionOverlay?.remove();
		this.activeCompletionOverlay = null;
		this.finishCompletedSession();
		void this.leaf.detach();
	}

	private removeKeyHandler(): void {
		if (!this.keyHandler) return;
		document.removeEventListener("keydown", this.keyHandler);
		this.keyHandler = null;
	}

	private installKeyHandler(q: Question, container: HTMLElement): void {
		this.removeKeyHandler();
		this.keyHandler = (e: KeyboardEvent) => {
			if (this.activeSkipOverlay || this.activeCompletionOverlay) return;
			const target = e.target as HTMLElement;
			if (target.tagName === "INPUT" && (target as HTMLInputElement).type !== "radio") return;

			if (!this.hasChecked) {
				if (q.type === "mcq" && q.options) {
					const letterMap: Record<string, number> = { a: 0, b: 1, c: 2, d: 3 };
					const idx = letterMap[e.key.toLowerCase()];
					if (idx !== undefined && idx < q.options.length) {
						e.preventDefault();
						this.selectedAnswer = q.options[idx]!;
						container.querySelectorAll(".ap-choice").forEach((el, i) => {
							el.removeClass("is-selected");
							if (i === idx) el.addClass("is-selected");
						});
						this.updateSubmitButton();
					}
				}

				if (e.key === "Enter" && this.selectedAnswer) {
					e.preventDefault();
					this.submitCurrentAnswer(q);
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
			if (this.activeCompletionOverlay) return;
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

	private startTimer(target: HTMLElement): void {
		this.stopTimer();
		this.timerId = window.setInterval(() => {
			target.setText(formatClock(Date.now() - this.questionStartTime));
		}, 1000);
	}

	private stopTimer(): void {
		if (this.timerId === null) return;
		window.clearInterval(this.timerId);
		this.timerId = null;
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

	private emitStateChange(): void {
		const s = this.state;
		if (!s?.onStateChange) return;
		s.onStateChange(s.questions, s.results, s.currentIndex);
	}

	private renderMarkdown(md: string, el: HTMLElement): void {
		renderMarkdown(this.app, md, el, this.renderComponent, {
			sourcePath: this.state?.topics[0]?.path ?? "",
			hoverParent: this,
			onInternalLinkClick: () => this.emitStateChange(),
		});
	}

	private topicSummary(): string {
		const topics = [...new Set(this.state?.questions.flatMap((q) => q.sourceTopics) ?? [])];
		if (topics.length === 0) return "Adaptive Practice";
		if (topics.length <= MAX_VISIBLE_TOPICS) return topics.join(", ");
		return `${topics.slice(0, MAX_VISIBLE_TOPICS).join(", ")} +${topics.length - MAX_VISIBLE_TOPICS} more`;
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

function formatClock(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatShortTime(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes ? `${hours}h ${restMinutes}m ${seconds}s` : `${hours}h ${seconds}s`;
}

function averageAttemptTime(results: QuizResult[]): string {
	if (results.length === 0) return "0s";
	const total = results.reduce((sum, result) => sum + result.timeTakenMs, 0);
	return formatShortTime(total / results.length);
}

function difficultyLabel(difficulty: Question["difficulty"]): string {
	if (difficulty === "easy") return "Easy";
	if (difficulty === "medium") return "Medium";
	return "Hard";
}
