import { MarkdownView, Notice, Plugin } from "obsidian";
import {
	AdaptivePracticeSettings,
	DEFAULT_SETTINGS,
	LLM_PROVIDER_LABELS,
	PROVIDER_PRESETS,
	DailySessionPlan,
	PracticeDraft,
	Question,
	QuizResult,
	SessionConfig,
	TopicNote,
} from "./types";
import { AdaptivePracticeSettingTab } from "./settings";
import { SetupModal } from "./ui/setup-modal";
import { QuizModal } from "./ui/quiz-modal";
import { ResultsModal } from "./ui/results-modal";
import { PracticeView, PRACTICE_VIEW_TYPE } from "./ui/practice-view";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./ui/dashboard-view";
import { ConfirmationModal } from "./ui/confirmation-modal";
import { generateQuestions, finalizeSession } from "./practice/session";
import { hasPracticedToday as memoryHasPracticedToday } from "./practice/daily-status";
import {
	applyPracticeMemoryToTopics,
	localDateKey,
	normalizePracticeMemory,
	planDailySession,
	reconcilePracticeMemory,
	reminderAttemptCooldownHasPassed,
	reminderTimeHasPassed,
	selectDailyTopics,
	selectPracticeMoreTopics,
	updatePracticeMemoryAfterSession,
} from "./practice/scheduler";
import { scanVaultSkeleton } from "./practice/indexer";
import { splitProviderCompatibleTopics } from "./practice/provider-capabilities";
import {
	getProviderSecretId,
	normalizeProviderSecretNames,
	syncLegacySecretName,
} from "./practice/provider-secrets";
import {
	buildPracticeDraft,
	normalizePracticeDraft,
	practiceDraftProgress,
	shouldConfirmPracticeDraftReplacement,
} from "./practice/draft";

export default class AdaptivePracticePlugin extends Plugin {
	settings: AdaptivePracticeSettings = DEFAULT_SETTINGS;
	private sessionTopics: TopicNote[] = [];
	private sessionGenerationInProgress = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.migrateApiKey();

		this.registerView(PRACTICE_VIEW_TYPE, (leaf) => new PracticeView(leaf));
		this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this));

		this.app.workspace.onLayoutReady(() => {
			this.detachPracticeLeaves();
			void this.refreshPracticePlan(false);
			void this.checkDailyReminder();
			this.showResumePracticeNotice();
		});

		this.registerInterval(window.setInterval(() => {
			void this.checkDailyReminder();
		}, 60 * 1000));

		this.registerInterval(window.setInterval(() => {
			void this.refreshPracticePlan(false);
		}, 30 * 60 * 1000));

		this.addRibbonIcon("graduation-cap", "Start practice session", () => {
			this.openSetupModal();
		});

		this.addRibbonIcon("calendar-check", "Open dashboard", () => {
			void this.openDashboard();
		});

		this.addCommand({
			id: "start",
			name: "Start practice session",
			callback: () => this.openSetupModal(),
		});

		this.addCommand({
			id: "open-dashboard",
			name: "Open dashboard",
			callback: () => {
				void this.openDashboard();
			},
		});

		this.addCommand({
			id: "start-daily-practice",
			name: "Start daily practice",
			callback: () => {
				void this.startDailyPractice();
			},
		});

		this.addCommand({
			id: "resume-practice-session",
			name: "Resume unfinished practice session",
			checkCallback: (checking) => {
				if (!this.settings.practiceDraft) return false;
				if (!checking) void this.resumePracticeDraft();
				return true;
			},
		});

		this.addCommand({
			id: "scan-practice-plan",
			name: "Scan vault for practice plan",
			callback: () => {
				void this.refreshPracticePlan(true);
			},
		});

		this.addCommand({
			id: "practice-current-note",
			name: "Practice current note",
			checkCallback: (checking) => {
				const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (mdView?.file) {
					if (!checking) this.openSetupModal(mdView.file.path);
					return true;
				}
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile?.extension === "pdf") {
					if (!checking) this.openSetupModal(activeFile.path);
					return true;
				}
				return false;
			},
		});

		this.addSettingTab(new AdaptivePracticeSettingTab(this.app, this));
	}

	onunload(): void {
		this.detachPracticeLeaves();
	}

	private detachPracticeLeaves(): void {
		this.app.workspace.getLeavesOfType(PRACTICE_VIEW_TYPE).forEach((leaf) => {
			leaf.detach();
		});
	}

	getSecretId(): string {
		return getProviderSecretId(this.settings);
	}

	getApiKey(): string | null {
		return this.app.secretStorage.getSecret(this.getSecretId());
	}

	setApiKey(value: string): void {
		this.app.secretStorage.setSecret(this.getSecretId(), value);
	}

	private async migrateApiKey(): Promise<void> {
		if (this.settings.geminiApiKey) {
			const id = PROVIDER_PRESETS.gemini.secretName;
			const existing = this.app.secretStorage.getSecret(id);
			if (!existing) {
				this.app.secretStorage.setSecret(id, this.settings.geminiApiKey);
			}
			this.settings.geminiApiKey = "";
			await this.saveSettings();
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = normalizeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async savePdfSkill(path: string, skill: number): Promise<void> {
		if (!this.settings.pdfSkills) this.settings.pdfSkills = {};
		this.settings.pdfSkills[path] = skill;
		await this.saveSettings();
	}

	async refreshPracticePlan(showNotice: boolean): Promise<TopicNote[]> {
		const scan = await scanVaultSkeleton(
			this.app,
			this.settings.practiceFolder,
			this.settings.pdfSkills,
			this.settings.filterRules,
			this.settings.practiceMemory.index,
			this.settings
		);
		const topics = scan.topics;
		const now = Date.now();
		this.settings.practiceMemory.index = scan.index;
		this.settings.practiceMemory = reconcilePracticeMemory(
			this.settings.practiceMemory,
			topics,
			now
		);
		await this.saveSettings();

		const indexed = applyPracticeMemoryToTopics(
			topics,
			this.settings.practiceMemory,
			now
		);
		if (showNotice) {
			const dueCount = selectDailyTopics(
				indexed,
				this.settings.practiceMemory,
				this.settings.dailyTopicLimit,
				now
			).length;
			new Notice(
				`Adaptive Practice scanned ${scan.stats.total} notes (${scan.stats.indexed} updated, ${scan.stats.reused} reused). ${dueCount} topic${dueCount === 1 ? "" : "s"} ready.`
			);
		}
		this.renderDashboardViews(indexed);
		return indexed;
	}

	openSetupModal(preselectedPath?: string): void {
		new SetupModal(
			this.app,
			this.settings,
			(config) => {
				void this.startSession(config);
			},
			preselectedPath
		).open();
	}

	async openDashboard(): Promise<void> {
		const leaf = this.app.workspace.getRightLeaf(false) ??
			this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	getDailyTopics(topics: TopicNote[], now = Date.now()): TopicNote[] {
		return this.getDailyTopicSelection(
			topics,
			now,
			this.hasPracticedToday(new Date(now))
		).compatibleTopics;
	}

	hasPracticedToday(now = new Date()): boolean {
		return memoryHasPracticedToday(this.settings.practiceMemory, now);
	}

	private getDailyTopicSelection(
		topics: TopicNote[],
		now = Date.now(),
		extraPractice = false
	): {
		compatibleTopics: TopicNote[];
		skippedPdfTopics: TopicNote[];
		warning: string;
	} {
		const providerCanReadPdfs = PROVIDER_PRESETS[this.settings.llmProvider].supportsPdfs;
		const candidateLimit = providerCanReadPdfs
			? this.settings.dailyTopicLimit
			: Math.min(topics.length, Math.max(this.settings.dailyTopicLimit, this.settings.dailyTopicLimit * 3));
		const candidates = extraPractice
			? selectPracticeMoreTopics(
				topics,
				this.settings.practiceMemory,
				candidateLimit,
				now
			)
			: selectDailyTopics(
				topics,
				this.settings.practiceMemory,
				candidateLimit,
				now
			);
		const compatibility = splitProviderCompatibleTopics(
			this.settings.llmProvider,
			candidates
		);
		return {
			...compatibility,
			compatibleTopics: compatibility.compatibleTopics.slice(
				0,
				this.settings.dailyTopicLimit
			),
		};
	}

	getDailySessionPlan(topics: TopicNote[]): DailySessionPlan {
		return this.buildDailySessionPlan(
			topics,
			this.hasPracticedToday()
		);
	}

	private buildDailySessionPlan(
		topics: TopicNote[],
		extraPractice: boolean
	): DailySessionPlan {
		const plan = planDailySession(
			topics,
			this.settings.practiceMemory,
			this.settings.dailyQuestionCount
		);
		if (!extraPractice) return plan;
		return {
			...plan,
			questionCount: Math.min(
				plan.questionCount,
				Math.max(3, Math.ceil(this.settings.dailyQuestionCount / 2))
			),
			reason: `extra practice: ${plan.reason}`,
		};
	}

	getPracticeDraft(): PracticeDraft | null {
		return this.settings.practiceDraft;
	}

	async resumePracticeDraft(): Promise<void> {
		const draft = normalizePracticeDraft(this.settings.practiceDraft);
		if (!draft) {
			await this.clearPracticeDraft();
			new Notice("No unfinished practice session to resume.");
			return;
		}
		this.settings.practiceDraft = draft;
		await this.saveSettings();
		this.renderDashboardViews();
		await this.openPracticeView(
			draft.questions,
			draft.results,
			draft.currentIndex,
			draft.topics,
			draft.config
		);
	}

	async discardPracticeDraft(): Promise<void> {
		await this.clearPracticeDraft();
		new Notice("Unfinished practice session discarded.");
	}

	async startDailyPractice(): Promise<void> {
		const topics = await this.refreshPracticePlan(false);
		const alreadyPracticedToday = this.hasPracticedToday();
		const selection = this.getDailyTopicSelection(
			topics,
			Date.now(),
			alreadyPracticedToday
		);
		const dailyTopics = selection.compatibleTopics;
		const plan = this.buildDailySessionPlan(
			dailyTopics,
			alreadyPracticedToday
		);

		if (dailyTopics.length === 0) {
			new Notice(selection.warning || "No practice topics are available right now.");
			return;
		}
		if (selection.skippedPdfTopics.length > 0) {
			new Notice(
				`Skipped ${selection.skippedPdfTopics.length} PDF topic${selection.skippedPdfTopics.length === 1 ? "" : "s"} for the current provider.`
			);
		}

		await this.startSession({
			topics: dailyTopics,
			questionCount: plan.questionCount,
			mode: "daily",
			challengeMode: plan.challengeMode,
			challengeReason: plan.reason,
		});
	}

	private async checkDailyReminder(): Promise<void> {
		if (!this.settings.dailyPracticeEnabled) return;
		const now = new Date();
		const today = localDateKey(now);
		if (this.settings.practiceMemory.daily.lastReminderDate === today) return;
		if (this.settings.practiceMemory.daily.lastPracticeDate === today) return;
		if (!reminderTimeHasPassed(this.settings.dailyReminderTime, now)) return;
		if (!reminderAttemptCooldownHasPassed(
			this.settings.practiceMemory.daily.lastReminderAttemptAt,
			now.getTime()
		)) return;

		const topics = await this.refreshPracticePlan(false);
		const selection = this.getDailyTopicSelection(topics, now.getTime());
		const dailyTopics = selection.compatibleTopics;

		if (dailyTopics.length === 0) {
			this.settings.practiceMemory.daily.lastReminderAttemptAt = now.getTime();
			await this.saveSettings();
			if (selection.warning) new Notice(selection.warning);
			return;
		}
		this.settings.practiceMemory.daily.lastReminderDate = today;
		this.settings.practiceMemory.daily.lastReminderAttemptAt = now.getTime();
		await this.saveSettings();
		this.showDailyPracticeNotice(
			dailyTopics.length,
			this.getDailySessionPlan(dailyTopics)
		);
	}

	private showDailyPracticeNotice(topicCount: number, plan: DailySessionPlan): void {
		const notice = new Notice("", 0);
		notice.messageEl.empty();
		notice.messageEl.createSpan({
			text: `${topicCount} Adaptive Practice topic${topicCount === 1 ? "" : "s"} ready for ${plan.questionCount} ${formatChallengeMode(plan.challengeMode)} questions. `,
		});
		const button = notice.messageEl.createEl("button", { text: "Start" });
		button.addEventListener("click", () => {
			notice.hide();
			void this.startDailyPractice();
		});
	}

	private showResumePracticeNotice(): void {
		const draft = this.settings.practiceDraft;
		if (!draft) return;
		const notice = new Notice("", 0);
		notice.messageEl.empty();
		notice.messageEl.createSpan({
			text: `Unfinished Adaptive Practice session (${practiceDraftProgress(draft)}). `,
		});
		const resume = notice.messageEl.createEl("button", { text: "Resume" });
		resume.addEventListener("click", () => {
			notice.hide();
			void this.resumePracticeDraft();
		});
		const discard = notice.messageEl.createEl("button", { text: "Discard" });
		discard.addEventListener("click", () => {
			notice.hide();
			void this.discardPracticeDraft();
		});
	}

	private async startSession(
		config: SessionConfig,
		options: { replaceDraft?: boolean } = {}
	): Promise<void> {
		if (this.sessionGenerationInProgress) {
			new Notice("Practice questions are already generating.");
			return;
		}
		if (shouldConfirmPracticeDraftReplacement(
			this.settings.practiceDraft,
			options.replaceDraft ?? false
		)) {
			this.confirmPracticeDraftReplacement(config);
			return;
		}

		this.sessionGenerationInProgress = true;
		const loadingNotice = new Notice(
			`Generating ${config.questionCount} adaptive question${config.questionCount === 1 ? "" : "s"} from ${config.topics.length} note${config.topics.length === 1 ? "" : "s"}... This can take a little while; the quiz will open when ready.`,
			0
		);

		try {
			const compatibility = splitProviderCompatibleTopics(
				this.settings.llmProvider,
				config.topics
			);
			if (compatibility.skippedPdfTopics.length > 0) {
				if (config.mode !== "daily" || compatibility.compatibleTopics.length === 0) {
					loadingNotice.hide();
					new Notice(compatibility.warning);
					return;
				}
				new Notice(
					`Skipped ${compatibility.skippedPdfTopics.length} PDF topic${compatibility.skippedPdfTopics.length === 1 ? "" : "s"} for the current provider.`
				);
				config = {
					...config,
					topics: compatibility.compatibleTopics,
				};
			}
			this.sessionTopics = config.topics;

			const apiKey = this.getApiKey() ?? "";
			if (!apiKey && this.providerNeedsApiKey()) {
				loadingNotice.hide();
				const label = LLM_PROVIDER_LABELS[this.settings.llmProvider];
				new Notice(`${label} API key not configured. Go to Settings \u2192 Adaptive Practice to add it.`);
				return;
			}

			const questions = await generateQuestions(
				this.app,
				apiKey,
				config,
				this.settings.llmProvider,
				this.settings
			);

			loadingNotice.hide();

			if (questions.length === 0) {
				new Notice("No questions were generated. Try different topics.");
				return;
			}

			shuffle(questions);
			await this.savePracticeDraft(config, questions, [], 0);

			const usedTopics = new Set(
				questions.flatMap((q) => q.sourceTopics)
			);
			const selectedCount = config.topics.length;
			const usedCount = config.topics.filter((t) =>
				usedTopics.has(t.title)
			).length;
			new Notice(
				`${questions.length} questions generated from ${usedCount} / ${selectedCount} selected notes.`
			);

			const onComplete = (results: QuizResult[]) => {
				void this.completeSession(config, results);
			};

			const onExpand = (qs: Question[], results: QuizResult[], currentIndex: number) => {
				void this.openPracticeView(qs, results, currentIndex, config.topics, config);
			};

			const onStateChange = (
				qs: Question[],
				results: QuizResult[],
				currentIndex: number
			) => {
				void this.savePracticeDraft(config, qs, results, currentIndex);
			};
			const onAbort = () => {
				void this.clearPracticeDraft();
			};

			new QuizModal(this.app, questions, onComplete, onExpand, onStateChange, onAbort).open();
		} catch (e) {
			loadingNotice.hide();
			new Notice(
				`Error: ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			this.sessionGenerationInProgress = false;
		}
	}

	private confirmPracticeDraftReplacement(config: SessionConfig): void {
		new ConfirmationModal(this.app, {
			title: "Replace unfinished session?",
			message: "Starting a new practice session will discard the generated questions saved from your unfinished session.",
			confirmText: "Start new session",
			cancelText: "Keep unfinished",
			destructive: true,
			onConfirm: () => {
				void (async () => {
					await this.clearPracticeDraft();
					await this.startSession(config, { replaceDraft: true });
				})();
			},
			onCancel: () => {
				new Notice("Unfinished practice session kept.");
			},
		}).open();
	}

	private providerNeedsApiKey(): boolean {
		if (this.settings.llmProvider !== "openai-compatible") return true;
		const baseUrl = getProviderBaseUrl(this.settings);
		return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\b/i.test(baseUrl);
	}

	private async completeSession(
		config: SessionConfig,
		results: QuizResult[]
	): Promise<void> {
		const finalNotice = new Notice("Saving results\u2026", 0);
		try {
			const deltas = await finalizeSession(
				this.app,
				config.topics,
				results,
				(path, skill) => this.savePdfSkill(path, skill)
			);
			this.settings.practiceMemory = updatePracticeMemoryAfterSession(
				this.settings.practiceMemory,
				config.topics,
				results,
				deltas
			);
			this.settings.practiceDraft = null;
			await this.saveSettings();
			this.renderDashboardViews();
			finalNotice.hide();
			new ResultsModal(this.app, results, deltas).open();
		} catch (e) {
			finalNotice.hide();
			new Notice(
				`Error saving results: ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}

	private async openPracticeView(
		questions: Question[],
		results: QuizResult[],
		currentIndex: number,
		topics: TopicNote[],
		config: SessionConfig
	): Promise<void> {
		await this.savePracticeDraft(config, questions, results, currentIndex, topics);
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: PRACTICE_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);

		const view = leaf.view;
		if (view instanceof PracticeView) {
			const onComplete = (completedResults: QuizResult[]) => {
				void this.completeSession(config, completedResults);
			};
			view.setPracticeState({
				questions,
				results,
				currentIndex,
				topics,
				onComplete,
				onDiscard: () => this.discardPracticeDraft(),
				onStateChange: (
					nextQuestions: Question[],
					nextResults: QuizResult[],
					nextIndex: number
				) => {
					void this.savePracticeDraft(
						config,
						nextQuestions,
						nextResults,
						nextIndex,
						topics
					);
				},
				questionPaneSide: this.settings.questionPaneSide,
			});
		}
	}

	private async savePracticeDraft(
		config: SessionConfig,
		questions: Question[],
		results: QuizResult[],
		currentIndex: number,
		topics = config.topics
	): Promise<void> {
		if (results.length >= questions.length) return;
		this.settings.practiceDraft = buildPracticeDraft(
			questions,
			results,
			currentIndex,
			topics,
			{ ...config, topics },
			Date.now()
		);
		await this.saveSettings();
		this.renderDashboardViews();
	}

	private async clearPracticeDraft(): Promise<void> {
		if (!this.settings.practiceDraft) return;
		this.settings.practiceDraft = null;
		await this.saveSettings();
		this.renderDashboardViews();
	}

	private renderDashboardViews(topics?: TopicNote[]): void {
		this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE).forEach((leaf) => {
			const view = leaf.view;
			if (view instanceof DashboardView) {
				view.renderCurrentState(topics);
			}
		});
	}
}

function shuffle<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j]!, arr[i]!];
	}
}

function normalizeSettings(raw: unknown): AdaptivePracticeSettings {
	const settings = Object.assign(
		{},
		JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AdaptivePracticeSettings,
		raw && typeof raw === "object" ? raw : {}
	);

	if (!(settings.llmProvider in LLM_PROVIDER_LABELS)) {
		settings.llmProvider = "gemini";
	}
	settings.providerSecretNames = normalizeProviderSecretNames(
		settings.providerSecretNames,
		settings.llmProvider,
		settings.secretName
	);
	syncLegacySecretName(settings);
	settings.providerBaseUrls = normalizeProviderStrings(settings.providerBaseUrls);
	settings.providerModels = normalizeProviderStrings(settings.providerModels);
	if (settings.providerModels.gemini === "gemini-2.0-flash") {
		settings.providerModels.gemini = PROVIDER_PRESETS.gemini.model;
	}
	if (settings.providerModels.anthropic === "claude-sonnet-4-20250514") {
		settings.providerModels.anthropic = PROVIDER_PRESETS.anthropic.model;
	}
	settings.providerJsonModes = normalizeProviderJsonModes(settings.providerJsonModes);
	settings.providerSupportsImages = normalizeProviderBooleans(settings.providerSupportsImages);
	if (!settings.filterRules || settings.filterRules.type !== "group") {
		settings.filterRules = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.filterRules)) as AdaptivePracticeSettings["filterRules"];
	}
	if (!settings.pdfSkills || typeof settings.pdfSkills !== "object") {
		settings.pdfSkills = {};
	}
	settings.createdDateProperties = stringSetting(
		settings.createdDateProperties,
		DEFAULT_SETTINGS.createdDateProperties
	);
	settings.updatedDateProperties = stringSetting(
		settings.updatedDateProperties,
		DEFAULT_SETTINGS.updatedDateProperties
	);
	if (!/^(\d{1,2}):(\d{2})$/.test(settings.dailyReminderTime)) {
		settings.dailyReminderTime = DEFAULT_SETTINGS.dailyReminderTime;
	}
	if (settings.questionPaneSide !== "left" && settings.questionPaneSide !== "right") {
		settings.questionPaneSide = DEFAULT_SETTINGS.questionPaneSide;
	}
	settings.defaultQuestionCount = clamp(settings.defaultQuestionCount, 5, 30, DEFAULT_SETTINGS.defaultQuestionCount);
	settings.dailyQuestionCount = clamp(settings.dailyQuestionCount, 3, 20, DEFAULT_SETTINGS.dailyQuestionCount);
	settings.dailyTopicLimit = clamp(settings.dailyTopicLimit, 1, 12, DEFAULT_SETTINGS.dailyTopicLimit);
	settings.practiceMemory = normalizePracticeMemory(settings.practiceMemory);
	settings.practiceDraft = normalizePracticeDraft(settings.practiceDraft);
	return settings;
}

function getProviderBaseUrl(settings: AdaptivePracticeSettings): string {
	return settings.providerBaseUrls[settings.llmProvider] ||
		PROVIDER_PRESETS[settings.llmProvider].baseUrl;
}

function stringSetting(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value : fallback;
}

function formatChallengeMode(mode: DailySessionPlan["challengeMode"]): string {
	if (mode === "warmup") return "warm-up";
	return mode;
}

function normalizeProviderStrings(
	input: unknown
): AdaptivePracticeSettings["providerBaseUrls"] {
	if (!input || typeof input !== "object") return {};
	const output: Record<string, string> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (key in LLM_PROVIDER_LABELS && typeof value === "string") {
			output[key] = value;
		}
	}
	return output as AdaptivePracticeSettings["providerBaseUrls"];
}

function normalizeProviderJsonModes(
	input: unknown
): AdaptivePracticeSettings["providerJsonModes"] {
	if (!input || typeof input !== "object") return {};
	const output: AdaptivePracticeSettings["providerJsonModes"] = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (
			key in LLM_PROVIDER_LABELS &&
			(value === "json_schema" || value === "json_object" || value === "prompt_only")
		) {
			output[key as keyof AdaptivePracticeSettings["providerJsonModes"]] =
				value;
		}
	}
	return output;
}

function normalizeProviderBooleans(
	input: unknown
): AdaptivePracticeSettings["providerSupportsImages"] {
	if (!input || typeof input !== "object") return {};
	const output: AdaptivePracticeSettings["providerSupportsImages"] = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (key in LLM_PROVIDER_LABELS && typeof value === "boolean") {
			output[key as keyof AdaptivePracticeSettings["providerSupportsImages"]] = value;
		}
	}
	return output;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
