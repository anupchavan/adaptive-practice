import { ItemView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type AdaptivePracticePlugin from "../main";
import {
	DailySessionPlan,
	NoteIndexEntry,
	NotePracticeState,
	PracticeDraft,
	TopicNote,
} from "../types";
import { practiceDraftProgress } from "../practice/draft";

export const DASHBOARD_VIEW_TYPE = "adaptive-practice-dashboard-view";

interface DashboardState {
	topics: TopicNote[];
	dailyTopics: TopicNote[];
	dailyPlan: DailySessionPlan;
	dailyWarning: string;
	dailyComplete: boolean;
	practiceDraft: PracticeDraft | null;
	loading: boolean;
}

export class DashboardView extends ItemView {
	private plugin: AdaptivePracticePlugin;
	private state: DashboardState = {
		topics: [],
		dailyTopics: [],
		dailyPlan: {
			questionCount: 0,
			challengeMode: "steady",
			reason: "loading",
		},
		dailyWarning: "",
		dailyComplete: false,
		practiceDraft: null,
		loading: true,
	};

	constructor(leaf: WorkspaceLeaf, plugin: AdaptivePracticePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Adaptive practice";
	}

	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("ap-dashboard-view");
		await this.plugin.setDashboardOpen(true);
		await this.reload(false);
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
		this.plugin.scheduleDashboardOpenSync();
	}

	async refresh(showNotice = false): Promise<void> {
		await this.reload(showNotice);
	}

	renderCurrentState(topics = this.state.topics): void {
		if (this.state.loading) return;
		const dailyComplete = this.plugin.hasPracticedToday();
		const overview = this.plugin.getDailyTopicOverview(topics);
		const dailyTopics = overview.topics;
		this.state = {
			topics,
			dailyTopics,
			dailyPlan: this.plugin.getDailySessionPlan(dailyTopics),
			dailyWarning: overview.warning,
			dailyComplete,
			practiceDraft: this.plugin.getPracticeDraft(),
			loading: false,
		};
		this.render();
	}

	private async reload(showNotice: boolean): Promise<void> {
		this.state.loading = true;
		this.render();
		const topics = await this.plugin.refreshPracticePlan(showNotice);
		const dailyComplete = this.plugin.hasPracticedToday();
		const overview = this.plugin.getDailyTopicOverview(topics);
		const dailyTopics = overview.topics;
		this.state = {
			topics,
			dailyTopics,
			dailyPlan: this.plugin.getDailySessionPlan(dailyTopics),
			dailyWarning: overview.warning,
			dailyComplete,
			practiceDraft: this.plugin.getPracticeDraft(),
			loading: false,
		};
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("ap-dashboard-view");

		const wrapper = contentEl.createDiv({ cls: "ap-dash-wrapper" });
		this.renderHeader(wrapper);

		if (this.state.loading) {
			wrapper.createDiv({
				text: "Scanning practice plan...",
				cls: "ap-dash-muted",
			});
			return;
		}

		this.renderStats(wrapper);
		this.renderActions(wrapper);
		this.renderDueTopics(wrapper);
	}

	private renderHeader(container: HTMLElement): void {
		const header = container.createDiv({ cls: "ap-dash-header" });
		const icon = header.createDiv({ cls: "ap-dash-header-icon" });
		setIcon(icon, "graduation-cap");
		const copy = header.createDiv();
		copy.createEl("h2", { text: "Adaptive practice" });
		copy.createDiv({
			text: "Daily review and due notes",
			cls: "ap-dash-subtitle",
		});
	}

	private renderStats(container: HTMLElement): void {
		const memory = this.plugin.settings.practiceMemory;
		const stats = container.createDiv({ cls: "ap-dash-stats" });
		this.renderStat(
			stats,
			"Streak",
			`${memory.daily.streak}`,
			this.state.dailyComplete
				? "ap-dash-stat-streak-done"
				: "ap-dash-stat-streak-due",
		);
		this.renderStat(stats, "Due notes", `${this.state.dailyTopics.length}`);
		this.renderStat(stats, "Plan", `${this.state.dailyPlan.questionCount}`);
	}

	private renderStat(
		container: HTMLElement,
		label: string,
		value: string,
		extraClass?: string,
	): void {
		const stat = container.createDiv({ cls: "ap-dash-stat" });
		if (extraClass) stat.addClass(extraClass);
		stat.createDiv({ text: value, cls: "ap-dash-stat-value" });
		stat.createDiv({ text: label, cls: "ap-dash-stat-label" });
	}

	private renderActions(container: HTMLElement): void {
		const actions = container.createDiv({ cls: "ap-dash-actions" });
		if (this.state.practiceDraft) {
			const resume = actions.createEl("button", {
				text: "Resume practice",
				cls: "mod-cta",
			});
			resume.addEventListener("click", () => {
				void this.plugin.resumePracticeDraft();
			});
		}

		const startDaily = actions.createEl("button", {
			text: this.state.dailyComplete ? "Practice more" : "Start daily",
			cls: this.state.practiceDraft ? "" : "mod-cta",
		});
		startDaily.disabled = this.state.dailyTopics.length === 0;
		startDaily.addEventListener("click", () => {
			void this.plugin.startDailyPractice();
		});

		const manual = actions.createEl("button", { text: "Choose notes" });
		manual.addEventListener("click", () => this.plugin.openSetupModal());

		const scan = actions.createEl("button", { text: "Scan" });
		scan.addEventListener("click", () => {
			void this.reload(true);
		});

		container.createDiv({
			text: this.state.practiceDraft
				? `Unfinished session: ${practiceDraftProgress(this.state.practiceDraft)}.`
				: this.state.dailyComplete
					? "Daily practice counted today. You can still take another limited batch if you want more reps."
					: `Today's plan: ${formatChallengeMode(this.state.dailyPlan.challengeMode)} · ${this.state.dailyPlan.reason}`,
			cls: "ap-dash-plan",
		});
		if (this.state.dailyWarning) {
			const warning = container.createDiv({ cls: "ap-dash-warning" });
			setIcon(
				warning.createSpan({ cls: "ap-dash-warning-icon" }),
				"info",
			);
			warning.createSpan({ text: this.state.dailyWarning });
		}
	}

	private renderDueTopics(container: HTMLElement): void {
		const section = container.createDiv({ cls: "ap-dash-section" });
		section.createEl("h3", {
			text: this.state.dailyComplete
				? "More practice available"
				: "Today's note mix",
		});

		if (this.state.dailyTopics.length === 0) {
			const empty = section.createDiv({ cls: "ap-dash-empty" });
			setIcon(
				empty.createSpan({ cls: "ap-dash-empty-icon" }),
				"check-circle",
			);
			empty.createSpan({
				text: this.state.dailyComplete
					? "Daily practice counted today. No extra batch is ready right now."
					: "Nothing is due right now.",
			});
			return;
		}

		const list = section.createDiv({ cls: "ap-dash-topic-list" });
		for (const topic of this.state.dailyTopics) {
			this.renderTopicRow(list, topic);
		}
	}

	private renderTopicRow(container: HTMLElement, topic: TopicNote): void {
		const row = container.createDiv({ cls: "ap-dash-topic-row" });
		row.addEventListener("click", () => {
			void this.openTopic(topic);
		});

		const main = row.createDiv({ cls: "ap-dash-topic-main" });
		const title = main.createDiv({ cls: "ap-dash-topic-title" });
		title.setText(topic.title);
		if (topic.isPdf) {
			title.createSpan({ text: "PDF", cls: "ap-pdf-badge" });
		}
		main.createDiv({
			text: topic.scheduleReason ?? "spacing",
			cls: "ap-dash-topic-reason",
		});
		const indexEntry = this.getIndexEntry(topic);
		if (indexEntry) {
			main.createDiv({
				text: formatIndexSummary(indexEntry),
				cls: "ap-dash-topic-index",
			});
		}
		const practiceState = this.getPracticeState(topic);
		if (practiceState && practiceState.attempts > 0) {
			main.createDiv({
				text: formatPracticeSummary(practiceState),
				cls: "ap-dash-topic-practice",
			});
		}

		const meta = row.createDiv({ cls: "ap-dash-topic-meta" });
		const skill = meta.createDiv({ cls: "ap-skill-badge" });
		skill.setText(`${Math.round(topic.skill)}`);
		if (topic.skill < 30) skill.addClass("ap-skill-low");
		else if (topic.skill < 70) skill.addClass("ap-skill-mid");
		else skill.addClass("ap-skill-high");
		meta.createDiv({
			text: formatDueText(topic.dueAt),
			cls: "ap-dash-topic-due",
		});
	}

	private async openTopic(topic: TopicNote): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(topic.path);
		if (!(file instanceof TFile)) {
			new Notice("Could not open topic.");
			return;
		}
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.openFile(file);
	}

	private getIndexEntry(topic: TopicNote): NoteIndexEntry | null {
		return this.plugin.settings.practiceMemory.index[topic.path] ?? null;
	}

	private getPracticeState(topic: TopicNote): NotePracticeState | null {
		return this.plugin.settings.practiceMemory.notes[topic.path] ?? null;
	}
}

function formatDueText(dueAt: number | undefined): string {
	if (!dueAt) return "Due now";
	const diffMs = dueAt - Date.now();
	if (diffMs <= 0) return "Due now";
	const diffHours = Math.ceil(diffMs / (60 * 60 * 1000));
	if (diffHours < 24) return `Due in ${diffHours}h`;
	const diffDays = Math.ceil(diffHours / 24);
	return `Due in ${diffDays}d`;
}

function formatIndexSummary(entry: NoteIndexEntry): string {
	const bits: string[] = [];
	if (entry.headings.length > 0) {
		bits.push(
			entry.headings
				.slice(0, 2)
				.map((heading) => heading.heading)
				.join(" / "),
		);
	}
	if (entry.tags.length > 0) {
		bits.push(entry.tags.slice(0, 2).join(" "));
	}
	if (entry.media.length > 0) {
		bits.push(`${entry.media.length} media`);
	}
	if (bits.length === 0 && entry.estimatedWordCount > 0) {
		bits.push(`~${entry.estimatedWordCount} words`);
	}
	return bits.length > 0 ? bits.join(" · ") : "Skeleton indexed";
}

function formatPracticeSummary(state: NotePracticeState): string {
	const bits = [
		`Last ${Math.round(state.lastSessionAccuracy * 100)}%`,
		`fluency ${Math.round(state.lastSessionFluency * 100)}%`,
		`avg ${formatDuration(state.averageTimeMs)}`,
	];
	if (state.skipped > 0) bits.push(`${state.skipped} skipped`);
	return bits.join(" · ");
}

function formatChallengeMode(mode: DailySessionPlan["challengeMode"]): string {
	if (mode === "warmup") return "warm-up";
	return mode;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
}
