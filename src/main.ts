import { ensureVaultSkills } from "./notes/vault-file";
import {
	MarkdownView,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import {
	AdaptivePracticeSettings,
	DEFAULT_SETTINGS,
	LLM_PROVIDER_LABELS,
	PROVIDER_PRESETS,
	DailySessionPlan,
	PracticeDraft,
	Question,
	QuestionFeedbackKind,
	QuizResult,
	SessionConfig,
	TopicNote,
} from "./types";
import { AdaptivePracticeSettingTab } from "./settings";
import { normalizeFilterRules } from "./filters/matcher";
import { SetupModal } from "./ui/setup-modal";
import { ResultsModal } from "./ui/results-modal";
import { PracticeView, PRACTICE_VIEW_TYPE } from "./ui/practice-view";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./ui/dashboard-view";
import { ConfirmationModal } from "./ui/confirmation-modal";
import { showActionNotice } from "./ui/notices";
import { ADAPTIVE_PRACTICE_HOVER_SOURCE } from "./ui/markdown";
import {
	createFlowSessionGenerator,
	generateQuestions,
	finalizeSession,
} from "./practice/session";
import { FlowSessionGenerator } from "./practice/flow-engine";
import { hasPracticedToday as memoryHasPracticedToday } from "./practice/daily-status";
import { resolvePracticeCredit } from "./practice/daily-credit";
import { recordQuestionFeedback as recordQuestionFeedbackInMemory } from "./practice/question-feedback";
import {
	applyPracticeMemoryToTopics,
	normalizePracticeMemory,
	planDailySession,
	reconcilePracticeMemory,
	recordDailyReminderAttempt,
	selectDailyTopics,
	selectPracticeMoreTopics,
	shouldOfferDailyReminder,
	suppressDailyReminderForToday,
	updatePracticeMemoryAfterSession,
	evaluatePracticeSessionMeaningfulness,
} from "./practice/scheduler";
import { scanVaultSkeleton } from "./practice/indexer";
import { readIndexStore, writeIndexStore } from "./practice/index-store";
import {
	migratePdfSkillPaths,
	migratePracticeMemoryPaths,
	prunePdfSkillPaths,
	prunePracticeMemoryPaths,
} from "./practice/path-migration";
import {
	dailyTopicCandidateLimitForProvider,
	splitProviderCompatibleTopics,
} from "./practice/provider-capabilities";
import {
	getProviderSecretId,
	normalizeProviderSecretNames,
	syncLegacySecretName,
} from "./practice/provider-secrets";
import { getSecretSafely, setSecretSafely } from "./practice/secret-storage";
import {
	normalizeProviderModels,
	providerModelsNeedNormalization,
} from "./practice/provider-models";
import {
	buildPracticeDraft,
	normalizePracticeDraft,
	practiceDraftProgress,
	shouldConfirmPracticeDraftReplacement,
} from "./practice/draft";
import { hasAnsweredEveryQuestion } from "./practice/results";

export default class AdaptivePracticePlugin extends Plugin {
	settings: AdaptivePracticeSettings = DEFAULT_SETTINGS;
	private sessionTopics: TopicNote[] = [];
	private sessionGenerationInProgress = false;
	private sessionGenerationId = 0;
	private dailyReminderNotice: Notice | null = null;
	private practiceStatusBarEl: HTMLElement | null = null;
	private incrementalIndexTimer: number | null = null;
	private dailyReminderCheckInProgress = false;
	private unloading = false;
	private practicePlanRefresh: Promise<TopicNote[]> | null = null;
	private practicePlanRefreshNoticeRequested = false;
	private dashboardOpenSyncTimer: number | null = null;
	private vaultChangePersistTimer: number | null = null;
	private workspaceRestoreComplete = false;

	async onload(): Promise<void> {
		void ensureVaultSkills(this.app);
		await this.loadSettings();
		await this.migrateApiKey();

		this.registerView(PRACTICE_VIEW_TYPE, (leaf) => new PracticeView(leaf));
		this.registerView(
			DASHBOARD_VIEW_TYPE,
			(leaf) => new DashboardView(leaf, this),
		);
		this.registerHoverLinkSource(ADAPTIVE_PRACTICE_HOVER_SOURCE, {
			display: "Adaptive Practice",
			defaultMod: false,
		});

		this.app.workspace.onLayoutReady(() => {
			void this.restoreWorkspaceAfterReload();
		});

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.scheduleDashboardOpenSync();
			}),
		);

		// Keep practice state attached to notes across renames/moves and pruned on
		// delete. Without these, all path-keyed state is silently orphaned.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.handleVaultRename(file, oldPath);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.handleVaultDelete(file);
			}),
		);

		// Event-driven index freshness: edits and new notes schedule one quiet
		// incremental sweep (the indexer skips files whose stats are unchanged)
		// instead of waiting for the half-hour interval. Debounced so a burst of
		// typing or a bulk import causes a single rescan.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				this.scheduleIncrementalIndexRefresh(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.scheduleIncrementalIndexRefresh(file);
			}),
		);
		this.register(() => {
			if (this.incrementalIndexTimer !== null) {
				window.clearTimeout(this.incrementalIndexTimer);
				this.incrementalIndexTimer = null;
			}
		});

		this.registerInterval(
			window.setInterval(() => {
				void this.checkDailyReminder();
			}, 60 * 1000),
		);

		this.registerInterval(
			window.setInterval(
				() => {
					void this.refreshPracticePlan(false);
				},
				30 * 60 * 1000,
			),
		);

		this.practiceStatusBarEl = this.addStatusBarItem();
		this.practiceStatusBarEl.addClass("mod-clickable");
		this.practiceStatusBarEl.setAttribute(
			"aria-label",
			"Practice streak and due notes. Click to open the dashboard.",
		);
		this.practiceStatusBarEl.addEventListener("click", () => {
			void this.openDashboard();
		});
		this.updatePracticeStatusBar();

		this.addRibbonIcon("graduation-cap", "Start practice session", () => {
			this.openSetupModal();
		});

		this.addRibbonIcon("brain", "Open dashboard", () => {
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
				if (!this.getPracticeDraft()) return false;
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
			id: "export-practice-dataset",
			name: "Export practice dataset",
			callback: () => {
				void this.exportPracticeDataset();
			},
		});

		this.addCommand({
			id: "practice-current-note",
			name: "Practice current note",
			checkCallback: (checking) => {
				const mdView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
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
		this.unloading = true;
		if (this.dashboardOpenSyncTimer !== null) {
			window.clearTimeout(this.dashboardOpenSyncTimer);
			this.dashboardOpenSyncTimer = null;
		}
		if (this.vaultChangePersistTimer !== null) {
			window.clearTimeout(this.vaultChangePersistTimer);
			this.vaultChangePersistTimer = null;
			void this.persistAfterVaultChange();
		}
		this.hideDailyReminderNotice();
		this.detachPracticeLeaves();
	}

	private detachPracticeLeaves(): void {
		this.app.workspace
			.getLeavesOfType(PRACTICE_VIEW_TYPE)
			.forEach((leaf) => {
				leaf.detach();
			});
	}

	private async restorePracticeViewsAfterReload(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(PRACTICE_VIEW_TYPE);
		if (leaves.length === 0) {
			this.showResumePracticeNotice();
			return;
		}

		const draft = normalizePracticeDraft(this.settings.practiceDraft);
		if (!draft) {
			leaves.forEach((leaf) => {
				leaf.detach();
			});
			await this.clearPracticeDraft();
			return;
		}
		if (draft.completed) {
			leaves.forEach((leaf) => {
				leaf.detach();
			});
			this.settings.practiceDraft = draft;
			await this.saveSettings();
			await this.completeSession(draft.config, draft.results);
			return;
		}

		this.settings.practiceDraft = draft;
		await this.saveSettings();
		this.renderDashboardViews();
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof PracticeView) {
				this.configurePracticeView(
					view,
					draft.questions,
					draft.results,
					draft.currentIndex,
					draft.topics,
					draft.config,
				);
			}
		}
	}

	private async restoreWorkspaceAfterReload(): Promise<void> {
		try {
			await this.restorePracticeViewsAfterReload();
			const dashboardWillScan = await this.restoreDashboardAfterReload();
			if (!dashboardWillScan) {
				await this.refreshPracticePlan(false);
			}
			await this.checkDailyReminder();
		} finally {
			this.workspaceRestoreComplete = true;
		}
	}

	getSecretId(): string {
		return getProviderSecretId(this.settings);
	}

	getApiKey(): string | null {
		return getSecretSafely(this.app, this.getSecretId());
	}

	setApiKey(value: string): void {
		setSecretSafely(this.app, this.getSecretId(), value);
	}

	private async migrateApiKey(): Promise<void> {
		if (this.settings.geminiApiKey) {
			const id = PROVIDER_PRESETS.gemini.secretName;
			const existing = getSecretSafely(this.app, id);
			if (!existing) {
				setSecretSafely(this.app, id, this.settings.geminiApiKey);
			}
			this.settings.geminiApiKey = "";
			await this.saveSettings();
		}
	}

	async loadSettings(): Promise<void> {
		const raw: unknown = await this.loadData();
		this.settings = normalizeSettings(raw);
		const migratedIndex = await this.loadIndexStore();
		if (migratedIndex || rawProviderModelsNeedNormalization(raw)) {
			await this.saveSettings();
		}
	}

	async saveSettings(): Promise<void> {
		// The skeleton index lives in its own file (see index-store), so it is
		// stripped from the data.json payload to keep this hot path small.
		const memory = this.settings.practiceMemory;
		await this.saveData({
			...this.settings,
			practiceMemory: { ...memory, index: {} },
		});
	}

	private pluginDir(): string {
		return (
			this.manifest.dir ??
			normalizePath(
				`${this.app.vault.configDir}/plugins/${this.manifest.id}`,
			)
		);
	}

	private async loadIndexStore(): Promise<boolean> {
		const stored = await readIndexStore(this.app, this.pluginDir());
		if (stored) {
			this.settings.practiceMemory.index = stored;
			this.settings.practiceMemory = normalizePracticeMemory(
				this.settings.practiceMemory,
			);
			return false;
		}
		// No store file yet. If data.json still carries a legacy inline index,
		// migrate it into its own file and let the caller drop it from data.json.
		if (Object.keys(this.settings.practiceMemory.index).length > 0) {
			await this.saveIndex();
			return true;
		}
		return false;
	}

	private async saveIndex(): Promise<void> {
		await writeIndexStore(
			this.app,
			this.pluginDir(),
			this.settings.practiceMemory.index,
		);
	}

	private handleVaultRename(file: TAbstractFile, oldPath: string): void {
		const isFolder = file instanceof TFolder;
		if (!isFolder && !(file instanceof TFile)) return;
		const newPath = file.path;
		if (newPath === oldPath) return;
		const memoryChanged = migratePracticeMemoryPaths(
			this.settings.practiceMemory,
			oldPath,
			newPath,
			isFolder,
		);
		const pdfChanged = migratePdfSkillPaths(
			this.settings.pdfSkills,
			oldPath,
			newPath,
			isFolder,
		);
		if (memoryChanged || pdfChanged) this.scheduleVaultChangePersist();
	}

	private handleVaultDelete(file: TAbstractFile): void {
		const isFolder = file instanceof TFolder;
		const memoryChanged = prunePracticeMemoryPaths(
			this.settings.practiceMemory,
			file.path,
			isFolder,
		);
		const pdfChanged = prunePdfSkillPaths(
			this.settings.pdfSkills,
			file.path,
			isFolder,
		);
		if (memoryChanged || pdfChanged) this.scheduleVaultChangePersist();
	}

	private scheduleVaultChangePersist(delayMs = 800): void {
		if (this.unloading) return;
		if (this.vaultChangePersistTimer !== null) {
			window.clearTimeout(this.vaultChangePersistTimer);
		}
		this.vaultChangePersistTimer = window.setTimeout(() => {
			this.vaultChangePersistTimer = null;
			void this.persistAfterVaultChange();
		}, delayMs);
	}

	private async persistAfterVaultChange(): Promise<void> {
		await this.saveSettings();
		await this.saveIndex();
		// Flush still runs during unload to avoid losing a pending rename
		// migration, but the views are tearing down then — don't render into them.
		if (!this.unloading) this.renderDashboardViews();
	}

	async savePdfSkill(path: string, skill: number): Promise<void> {
		if (!this.settings.pdfSkills) this.settings.pdfSkills = {};
		this.settings.pdfSkills[path] = skill;
		await this.saveSettings();
	}

	/**
	 * Write the accumulated learning signals as JSONL — question feedback rows
	 * plus per-note practice state. This is the $0 groundwork for any future
	 * validator/judge model: labeled data accrues from normal use.
	 */
	private async exportPracticeDataset(): Promise<void> {
		const memory = this.settings.practiceMemory;
		const rows: string[] = [];
		for (const entry of memory.questionFeedback ?? []) {
			rows.push(
				JSON.stringify({ record: "question_feedback", ...entry }),
			);
		}
		for (const note of Object.values(memory.notes ?? {})) {
			rows.push(
				JSON.stringify({
					record: "note_state",
					path: note.path,
					skill: note.skill,
					attempts: note.attempts,
					correct: note.correct,
					skipped: note.skipped,
					stabilityDays: note.stabilityDays,
					lastSessionAccuracy: note.lastSessionAccuracy,
					lastSessionFluency: note.lastSessionFluency,
					practicedSubtopics: note.practicedSubtopics,
				}),
			);
		}
		if (rows.length === 0) {
			new Notice("No practice data to export yet.");
			return;
		}
		const path = normalizePath("adaptive-practice-dataset.jsonl");
		const content = rows.join("\n") + "\n";
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}
		new Notice(`Exported ${rows.length} rows to ${path}.`);
	}

	private scheduleIncrementalIndexRefresh(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const extension = file.extension?.toLowerCase();
		if (extension !== "md" && extension !== "pdf") return;
		if (this.incrementalIndexTimer !== null) {
			window.clearTimeout(this.incrementalIndexTimer);
		}
		this.incrementalIndexTimer = window.setTimeout(() => {
			this.incrementalIndexTimer = null;
			void this.refreshPracticePlan(false);
		}, 30_000);
	}

	async refreshPracticePlan(showNotice: boolean): Promise<TopicNote[]> {
		if (showNotice) this.practicePlanRefreshNoticeRequested = true;
		if (this.practicePlanRefresh) {
			if (showNotice)
				new Notice("Adaptive practice scan already running...");
			return this.practicePlanRefresh;
		}

		this.practicePlanRefresh = this.runPracticePlanRefresh().finally(() => {
			this.practicePlanRefresh = null;
			this.practicePlanRefreshNoticeRequested = false;
		});
		return this.practicePlanRefresh;
	}

	private async runPracticePlanRefresh(): Promise<TopicNote[]> {
		const scan = await scanVaultSkeleton(
			this.app,
			this.settings.practiceFolder,
			this.settings.pdfSkills,
			this.settings.filterRules,
			this.settings.practiceMemory.index,
			this.settings,
		);
		const topics = scan.topics;
		const now = Date.now();
		this.settings.practiceMemory.index = scan.index;
		this.settings.practiceMemory = reconcilePracticeMemory(
			this.settings.practiceMemory,
			topics,
			now,
		);
		await this.saveSettings();
		await this.saveIndex();

		const indexed = applyPracticeMemoryToTopics(
			topics,
			this.settings.practiceMemory,
			now,
		);
		if (this.practicePlanRefreshNoticeRequested) {
			const dueCount = selectDailyTopics(
				indexed,
				this.settings.practiceMemory,
				this.settings.dailyTopicLimit,
				now,
			).length;
			new Notice(
				`Adaptive Practice scanned ${scan.stats.total} notes (${scan.stats.indexed} updated, ${scan.stats.reused} reused). ${dueCount} topic${dueCount === 1 ? "" : "s"} ready.`,
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
			preselectedPath,
		).open();
	}

	async openDashboard(): Promise<void> {
		await this.setDashboardOpen(true);
		// Reuse an existing dashboard leaf (per the Views docs pattern) —
		// always creating one duplicated the tab after plugin updates, when
		// the previous leaf survives the reload.
		const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];
		const leaf =
			existing ??
			this.app.workspace.getRightLeaf(false) ??
			this.app.workspace.getLeaf("tab");
		if (!existing) {
			await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
		}
		this.app.workspace.rightSplit.expand();
		await this.app.workspace.revealLeaf(leaf);
	}

	async setDashboardOpen(open: boolean): Promise<void> {
		if (!open && this.unloading) return;
		if (this.settings.dashboardOpen === open) return;
		this.settings.dashboardOpen = open;
		await this.saveSettings();
	}

	scheduleDashboardOpenSync(delayMs = 750): void {
		if (!this.workspaceRestoreComplete || this.unloading) return;
		if (this.dashboardOpenSyncTimer !== null) {
			window.clearTimeout(this.dashboardOpenSyncTimer);
		}
		this.dashboardOpenSyncTimer = window.setTimeout(() => {
			this.dashboardOpenSyncTimer = null;
			void this.syncDashboardOpenState();
		}, delayMs);
	}

	private async syncDashboardOpenState(): Promise<void> {
		if (this.unloading) return;
		// A reload can race the revival of the pre-update leaf and leave two
		// dashboards; keep the first, detach the rest.
		const leaves = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
		for (const extra of leaves.slice(1)) extra.detach();
		await this.setDashboardOpen(leaves.length > 0);
	}

	private async restoreDashboardAfterReload(): Promise<boolean> {
		if (this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE).length > 0)
			return true;
		if (!this.settings.dashboardOpen) return false;
		await this.openDashboard();
		return true;
	}

	getDailyTopics(topics: TopicNote[], now = Date.now()): TopicNote[] {
		return this.getDailyTopicOverview(topics, now).topics;
	}

	getDailyTopicOverview(
		topics: TopicNote[],
		now = Date.now(),
	): { topics: TopicNote[]; warning: string; skippedPdfCount: number } {
		const selection = this.getDailyTopicSelection(
			topics,
			now,
			this.hasPracticedToday(new Date(now)),
		);
		return {
			topics: selection.compatibleTopics,
			warning: selection.warning,
			skippedPdfCount: selection.skippedPdfTopics.length,
		};
	}

	hasPracticedToday(now = new Date()): boolean {
		return memoryHasPracticedToday(this.settings.practiceMemory, now);
	}

	private getDailyTopicSelection(
		topics: TopicNote[],
		now = Date.now(),
		extraPractice = false,
	): {
		compatibleTopics: TopicNote[];
		skippedPdfTopics: TopicNote[];
		warning: string;
	} {
		const candidateLimit = dailyTopicCandidateLimitForProvider(
			this.settings.llmProvider,
			topics.length,
			this.settings.dailyTopicLimit,
		);
		const candidates = extraPractice
			? selectPracticeMoreTopics(
					topics,
					this.settings.practiceMemory,
					candidateLimit,
					now,
				)
			: selectDailyTopics(
					topics,
					this.settings.practiceMemory,
					candidateLimit,
					now,
				);
		const compatibility = splitProviderCompatibleTopics(
			this.settings.llmProvider,
			candidates,
		);
		return {
			...compatibility,
			compatibleTopics: compatibility.compatibleTopics.slice(
				0,
				this.settings.dailyTopicLimit,
			),
		};
	}

	getDailySessionPlan(topics: TopicNote[]): DailySessionPlan {
		return this.buildDailySessionPlan(topics, this.hasPracticedToday());
	}

	private buildDailySessionPlan(
		topics: TopicNote[],
		extraPractice: boolean,
	): DailySessionPlan {
		const plan = planDailySession(
			topics,
			this.settings.practiceMemory,
			this.settings.dailyQuestionCount,
		);
		if (!extraPractice) return plan;
		return {
			...plan,
			reason: `extra practice: ${plan.reason}`,
		};
	}

	getPracticeDraft(): PracticeDraft | null {
		return normalizePracticeDraft(this.settings.practiceDraft);
	}

	async resumePracticeDraft(): Promise<void> {
		const draft = normalizePracticeDraft(this.settings.practiceDraft);
		if (!draft) {
			await this.clearPracticeDraft();
			new Notice("No unfinished practice session to resume.");
			return;
		}
		if (draft.completed) {
			await this.completeSession(draft.config, draft.results);
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
			draft.config,
		);
	}

	async discardPracticeDraft(): Promise<void> {
		await this.clearPracticeDraft();
	}

	async startDailyPractice(): Promise<void> {
		const topics = await this.refreshPracticePlan(false);
		const alreadyPracticedToday = this.hasPracticedToday();
		const selection = this.getDailyTopicSelection(
			topics,
			Date.now(),
			alreadyPracticedToday,
		);
		const dailyTopics = selection.compatibleTopics;
		const plan = this.buildDailySessionPlan(
			dailyTopics,
			alreadyPracticedToday,
		);

		if (dailyTopics.length === 0) {
			new Notice(
				selection.warning ||
					"No practice topics are available right now.",
			);
			return;
		}
		if (selection.skippedPdfTopics.length > 0) {
			new Notice(
				`Skipped ${selection.skippedPdfTopics.length} PDF topic${selection.skippedPdfTopics.length === 1 ? "" : "s"} for the current provider.`,
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
		if (this.dailyReminderCheckInProgress) return;
		const now = new Date();
		if (
			!shouldOfferDailyReminder({
				enabled: this.settings.dailyPracticeEnabled,
				reminderTime: this.settings.dailyReminderTime,
				memory: this.settings.practiceMemory,
				now,
				hasPracticeDraft: !!this.getPracticeDraft(),
				generationInProgress: this.sessionGenerationInProgress,
				noticeActive: !!this.dailyReminderNotice,
			})
		)
			return;

		this.dailyReminderCheckInProgress = true;
		try {
			const topics = await this.refreshPracticePlan(false);
			const selection = this.getDailyTopicSelection(
				topics,
				now.getTime(),
			);
			const dailyTopics = selection.compatibleTopics;

			if (dailyTopics.length === 0) {
				this.settings.practiceMemory = recordDailyReminderAttempt(
					this.settings.practiceMemory,
					now.getTime(),
				);
				await this.saveSettings();
				if (selection.warning) new Notice(selection.warning);
				return;
			}
			this.settings.practiceMemory = recordDailyReminderAttempt(
				this.settings.practiceMemory,
				now.getTime(),
			);
			await this.saveSettings();
			this.showDailyPracticeNotice(
				dailyTopics.length,
				this.getDailySessionPlan(dailyTopics),
			);
		} finally {
			this.dailyReminderCheckInProgress = false;
		}
	}

	private showDailyPracticeNotice(
		topicCount: number,
		plan: DailySessionPlan,
	): void {
		this.hideDailyReminderNotice();
		const streak = this.settings.practiceMemory?.daily?.streak ?? 0;
		const streakPrefix = streak > 0 ? `🔥 ${streak}-day streak. ` : "";
		const notice = showActionNotice(
			`${streakPrefix}${topicCount} topic${topicCount === 1 ? "" : "s"} ready for ${plan.questionCount} ${formatChallengeMode(plan.challengeMode)} questions.`,
			[
				{
					label: "Start",
					kind: "primary",
					onClick: () => {
						this.hideDailyReminderNotice(notice);
						void this.startDailyPractice();
					},
				},
				{
					label: "Later",
					kind: "tertiary",
					onClick: () => this.hideDailyReminderNotice(notice),
				},
				{
					label: "Tomorrow",
					kind: "tertiary",
					onClick: () => {
						this.settings.practiceMemory =
							suppressDailyReminderForToday(
								this.settings.practiceMemory,
							);
						void this.saveSettings();
						this.hideDailyReminderNotice(notice);
					},
				},
			],
		);
		this.dailyReminderNotice = notice;
		this.watchNoticeDismissal(notice);
	}

	private hideDailyReminderNotice(notice = this.dailyReminderNotice): void {
		if (!notice) return;
		if (this.dailyReminderNotice === notice) {
			this.dailyReminderNotice = null;
		}
		notice.hide();
	}

	private watchNoticeDismissal(notice: Notice): void {
		const parent = notice.containerEl.parentElement;
		if (!parent) return;
		const observer = new MutationObserver(() => {
			if (notice.containerEl.isConnected) return;
			if (this.dailyReminderNotice === notice) {
				this.dailyReminderNotice = null;
			}
			observer.disconnect();
		});
		observer.observe(parent, { childList: true });
		this.register(() => observer.disconnect());
	}

	private showResumePracticeNotice(): void {
		const draft = normalizePracticeDraft(this.settings.practiceDraft);
		if (!draft) return;
		if (draft.completed) {
			void this.completeSession(draft.config, draft.results);
			return;
		}
		const notice = showActionNotice(
			`Unfinished practice session (${practiceDraftProgress(draft)}).`,
			[
				{
					label: "Resume",
					kind: "primary",
					onClick: () => {
						notice.hide();
						void this.resumePracticeDraft();
					},
				},
				{
					label: "Discard",
					kind: "tertiary",
					onClick: () => {
						notice.hide();
						void this.discardPracticeDraft();
					},
				},
			],
		);
	}

	private async startSession(
		config: SessionConfig,
		options: { replaceDraft?: boolean } = {},
	): Promise<void> {
		if (this.sessionGenerationInProgress) {
			new Notice("Practice questions are already generating.");
			return;
		}
		this.hideDailyReminderNotice();
		if (
			shouldConfirmPracticeDraftReplacement(
				this.settings.practiceDraft,
				options.replaceDraft ?? false,
			)
		) {
			this.confirmPracticeDraftReplacement(config);
			return;
		}

		this.sessionGenerationInProgress = true;
		const generationId = ++this.sessionGenerationId;
		let canceled = false;
		const loadingNotice = this.createGenerationNotice(config, () => {
			canceled = true;
			this.cancelSessionGeneration(generationId, loadingNotice);
		});

		try {
			const compatibility = splitProviderCompatibleTopics(
				this.settings.llmProvider,
				config.topics,
			);
			if (compatibility.skippedPdfTopics.length > 0) {
				if (
					config.mode !== "daily" ||
					compatibility.compatibleTopics.length === 0
				) {
					loadingNotice.hide();
					new Notice(compatibility.warning);
					return;
				}
				new Notice(
					`Skipped ${compatibility.skippedPdfTopics.length} PDF topic${compatibility.skippedPdfTopics.length === 1 ? "" : "s"} for the current provider.`,
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
				new Notice(
					`${label} API key not configured. Go to Settings \u2192 Adaptive Practice to add it.`,
				);
				return;
			}

			// Flow mode: generate a small opening batch for fast time-to-first-
			// question; later batches arrive in the background, conditioned on
			// how the session is going. Single-shot remains for small sessions
			// and as the fallback when flow is disabled.
			const useFlow =
				this.settings.flowGeneration && config.questionCount > 4;
			let flow: FlowSessionGenerator | undefined;
			let questions: Question[];
			if (useFlow) {
				flow = await createFlowSessionGenerator(
					this.app,
					apiKey,
					config,
					this.settings.llmProvider,
					this.settings,
				);
				// Sessions start on the unverified batch; when the blind
				// re-solve lands, contested questions the learner hasn't
				// reached are quietly retracted.
				flow.onBatchVerified = (verified, original) => {
					const surviving = new Set(verified.map((q) => q.id));
					flow?.noteRetracted(original.length - verified.length);
					const contested = new Set(
						original
							.filter((q) => !surviving.has(q.id))
							.map((q) => q.id),
					);
					for (const leaf of this.app.workspace.getLeavesOfType(
						PRACTICE_VIEW_TYPE,
					)) {
						if (leaf.view instanceof PracticeView) {
							leaf.view.retractQuestions(contested);
						}
					}
				};
				questions = await flow.firstBatch();
			} else {
				questions = await generateQuestions(
					this.app,
					apiKey,
					config,
					this.settings.llmProvider,
					this.settings,
				);
			}

			if (this.isStaleGeneration(generationId, canceled)) {
				loadingNotice.hide();
				return;
			}

			loadingNotice.hide();

			if (questions.length === 0) {
				new Notice(
					"No questions were generated. Try different topics.",
				);
				return;
			}

			await this.savePracticeDraft(config, questions, [], 0);

			const usedTopics = new Set(
				questions.flatMap((q) => q.sourceTopics),
			);
			const selectedCount = config.topics.length;
			const usedCount = config.topics.filter((t) =>
				usedTopics.has(t.title),
			).length;
			new Notice(
				flow
					? `Practice started — ${questions.length} of ${config.questionCount} questions ready; the rest adapt to your answers.`
					: `${questions.length} questions generated from ${usedCount} / ${selectedCount} selected notes.`,
			);

			await this.openPracticeView(
				questions,
				[],
				0,
				config.topics,
				config,
				flow,
			);
		} catch (e) {
			if (this.isStaleGeneration(generationId, canceled)) return;
			loadingNotice.hide();
			new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			if (this.sessionGenerationId === generationId) {
				this.sessionGenerationInProgress = false;
			}
		}
	}

	private createGenerationNotice(
		config: SessionConfig,
		onCancel: () => void,
	): Notice {
		return showActionNotice(
			`Generating ${config.questionCount} adaptive question${config.questionCount === 1 ? "" : "s"} from ${config.topics.length} note${config.topics.length === 1 ? "" : "s"}… The practice tab opens when ready.`,
			[{ label: "Cancel", kind: "tertiary", onClick: onCancel }],
		);
	}

	private cancelSessionGeneration(
		generationId: number,
		notice: Notice,
	): void {
		if (this.sessionGenerationId !== generationId) return;
		this.sessionGenerationInProgress = false;
		this.sessionGenerationId++;
		notice.hide();
		new Notice("Question generation cancelled.");
	}

	private isStaleGeneration(
		generationId: number,
		canceled: boolean,
	): boolean {
		return canceled || this.sessionGenerationId !== generationId;
	}

	private confirmPracticeDraftReplacement(config: SessionConfig): void {
		new ConfirmationModal(this.app, {
			title: "Replace unfinished session?",
			message:
				"Starting a new practice session will discard the generated questions saved from your unfinished session.",
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
		return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\b/i.test(
			baseUrl,
		);
	}

	private async completeSession(
		config: SessionConfig,
		results: QuizResult[],
	): Promise<void> {
		const finalNotice = new Notice("Saving results\u2026", 0);
		try {
			const completedAt = Date.now();
			const previousMemory = this.settings.practiceMemory;
			const dailyMeaningfulness =
				config.mode === "daily"
					? evaluatePracticeSessionMeaningfulness(results)
					: null;
			const recordResults =
				!dailyMeaningfulness || dailyMeaningfulness.meaningful;
			const deltas = recordResults
				? await finalizeSession(
						this.app,
						config.topics,
						results,
						(path, skill) => this.savePdfSkill(path, skill),
					)
				: [];
			if (recordResults) {
				this.settings.practiceMemory = updatePracticeMemoryAfterSession(
					this.settings.practiceMemory,
					config.topics,
					results,
					deltas,
					completedAt,
					{
						countDailyCredit: config.mode === "daily",
						targetRetention: this.settings.targetRetention,
					},
				);
			}
			const practiceCredit =
				config.mode === "daily"
					? resolvePracticeCredit(
							previousMemory,
							this.settings.practiceMemory,
							new Date(completedAt),
							results,
						)
					: null;
			this.settings.practiceDraft = null;
			await this.saveSettings();
			this.renderDashboardViews();
			finalNotice.hide();
			new ResultsModal(
				this.app,
				results,
				deltas,
				practiceCredit,
				(result, feedback) =>
					this.recordQuestionFeedback(result, feedback),
			).open();
		} catch (e) {
			finalNotice.hide();
			new Notice(
				`Error saving results: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
	}

	private async recordQuestionFeedback(
		result: QuizResult,
		feedback: QuestionFeedbackKind,
	): Promise<void> {
		this.settings.practiceMemory = recordQuestionFeedbackInMemory(
			this.settings.practiceMemory,
			result,
			feedback,
		);
		await this.saveSettings();
	}

	private async openPracticeView(
		questions: Question[],
		results: QuizResult[],
		currentIndex: number,
		topics: TopicNote[],
		config: SessionConfig,
		flow?: FlowSessionGenerator,
	): Promise<void> {
		await this.savePracticeDraft(
			config,
			questions,
			results,
			currentIndex,
			topics,
		);
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: PRACTICE_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);

		const view = leaf.view;
		if (view instanceof PracticeView) {
			this.configurePracticeView(
				view,
				questions,
				results,
				currentIndex,
				topics,
				config,
				flow,
			);
		}
	}

	private configurePracticeView(
		view: PracticeView,
		questions: Question[],
		results: QuizResult[],
		currentIndex: number,
		topics: TopicNote[],
		config: SessionConfig,
		flow?: FlowSessionGenerator,
	): void {
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
				nextIndex: number,
			) => {
				void this.savePracticeDraft(
					config,
					nextQuestions,
					nextResults,
					nextIndex,
					topics,
				);
			},
			questionPaneSide: this.settings.questionPaneSide,
			totalPlannedCount: flow ? flow.totalPlanned : undefined,
			onNeedMoreQuestions: flow
				? (sessionResults: QuizResult[], asked: Question[]) =>
						flow.nextBatch(sessionResults, asked)
				: undefined,
		});
	}

	private async savePracticeDraft(
		config: SessionConfig,
		questions: Question[],
		results: QuizResult[],
		currentIndex: number,
		topics = config.topics,
	): Promise<void> {
		const completed = hasAnsweredEveryQuestion(questions, results);
		this.settings.practiceDraft = buildPracticeDraft(
			questions,
			results,
			currentIndex,
			topics,
			{ ...config, topics },
			Date.now(),
		);
		if (completed && this.settings.practiceDraft) {
			this.settings.practiceDraft.completed = true;
		}
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
		this.app.workspace
			.getLeavesOfType(DASHBOARD_VIEW_TYPE)
			.forEach((leaf) => {
				const view = leaf.view;
				if (view instanceof DashboardView) {
					view.renderCurrentState(topics);
				}
			});
		this.updatePracticeStatusBar();
	}

	private updatePracticeStatusBar(): void {
		const el = this.practiceStatusBarEl;
		if (!el) return;
		if (!this.settings.dailyPracticeEnabled) {
			el.toggle(false);
			return;
		}
		const memory = this.settings.practiceMemory;
		const streak = memory?.daily?.streak ?? 0;
		const now = Date.now();
		const due = Object.values(memory?.notes ?? {}).filter(
			(note) => note.attempts > 0 && note.dueAt > 0 && note.dueAt <= now,
		).length;
		const parts: string[] = [];
		if (streak > 0) parts.push(`🔥 ${streak}d`);
		parts.push(`${due} due`);
		el.setText(`Practice ${parts.join(" · ")}`);
		el.toggle(true);
	}
}

function normalizeSettings(raw: unknown): AdaptivePracticeSettings {
	const settings = Object.assign(
		{},
		JSON.parse(
			JSON.stringify(DEFAULT_SETTINGS),
		) as AdaptivePracticeSettings,
		raw && typeof raw === "object" ? raw : {},
	);

	if (!(settings.llmProvider in LLM_PROVIDER_LABELS)) {
		settings.llmProvider = "gemini";
	}
	settings.providerSecretNames = normalizeProviderSecretNames(
		settings.providerSecretNames,
		settings.llmProvider,
		settings.secretName,
	);
	syncLegacySecretName(settings);
	settings.providerBaseUrls = normalizeProviderStrings(
		settings.providerBaseUrls,
	);
	if (
		settings.providerBaseUrls.openai ===
		"https://api.openai.com/v1/chat/completions"
	) {
		settings.providerBaseUrls.openai = PROVIDER_PRESETS.openai.baseUrl;
	}
	settings.providerModels = normalizeProviderModels(settings.providerModels);
	settings.providerJsonModes = normalizeProviderJsonModes(
		settings.providerJsonModes,
	);
	settings.providerSupportsImages = normalizeProviderBooleans(
		settings.providerSupportsImages,
	);
	// Stored filter rules keep the pre-0.5 shape; this validates the tree and
	// drops only structurally malformed entries (see normalizeFilterRules).
	settings.filterRules = normalizeFilterRules(settings.filterRules);
	if (!settings.pdfSkills || typeof settings.pdfSkills !== "object") {
		settings.pdfSkills = {};
	}
	settings.createdDateProperties = stringSetting(
		settings.createdDateProperties,
		DEFAULT_SETTINGS.createdDateProperties,
	);
	settings.updatedDateProperties = stringSetting(
		settings.updatedDateProperties,
		DEFAULT_SETTINGS.updatedDateProperties,
	);
	if (!/^(\d{1,2}):(\d{2})$/.test(settings.dailyReminderTime)) {
		settings.dailyReminderTime = DEFAULT_SETTINGS.dailyReminderTime;
	}
	if (
		settings.questionPaneSide !== "left" &&
		settings.questionPaneSide !== "right"
	) {
		settings.questionPaneSide = DEFAULT_SETTINGS.questionPaneSide;
	}
	settings.dashboardOpen = settings.dashboardOpen === true;
	settings.defaultQuestionCount = clamp(
		settings.defaultQuestionCount,
		5,
		30,
		DEFAULT_SETTINGS.defaultQuestionCount,
	);
	settings.dailyQuestionCount = clamp(
		settings.dailyQuestionCount,
		3,
		20,
		DEFAULT_SETTINGS.dailyQuestionCount,
	);
	settings.dailyTopicLimit = clamp(
		settings.dailyTopicLimit,
		1,
		30,
		DEFAULT_SETTINGS.dailyTopicLimit,
	);
	settings.targetRetention = clamp(
		settings.targetRetention,
		0.7,
		0.97,
		DEFAULT_SETTINGS.targetRetention,
	);
	if (
		settings.practiceIntent !== "mastery" &&
		settings.practiceIntent !== "cram" &&
		settings.practiceIntent !== "review"
	) {
		settings.practiceIntent = DEFAULT_SETTINGS.practiceIntent;
	}
	settings.flowGeneration = settings.flowGeneration !== false;
	settings.verifyAnswers = settings.verifyAnswers !== false;
	settings.deepAuthoring = settings.deepAuthoring === true;
	settings.practiceMemory = normalizePracticeMemory(settings.practiceMemory);
	settings.practiceDraft = normalizePracticeDraft(settings.practiceDraft);
	return settings;
}

function getProviderBaseUrl(settings: AdaptivePracticeSettings): string {
	return (
		settings.providerBaseUrls[settings.llmProvider] ||
		PROVIDER_PRESETS[settings.llmProvider].baseUrl
	);
}

function rawProviderModelsNeedNormalization(raw: unknown): boolean {
	if (!raw || typeof raw !== "object") return false;
	const providerModels = (raw as Partial<AdaptivePracticeSettings>)
		.providerModels;
	return providerModelsNeedNormalization(providerModels);
}

function stringSetting(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value : fallback;
}

function formatChallengeMode(mode: DailySessionPlan["challengeMode"]): string {
	if (mode === "warmup") return "warm-up";
	return mode;
}

function normalizeProviderStrings(
	input: unknown,
): AdaptivePracticeSettings["providerBaseUrls"] {
	if (!input || typeof input !== "object") return {};
	const output: AdaptivePracticeSettings["providerBaseUrls"] = {};
	for (const [key, value] of Object.entries(
		input as Record<string, unknown>,
	)) {
		if (key in LLM_PROVIDER_LABELS && typeof value === "string") {
			output[key as keyof AdaptivePracticeSettings["providerBaseUrls"]] =
				value;
		}
	}
	return output;
}

function normalizeProviderJsonModes(
	input: unknown,
): AdaptivePracticeSettings["providerJsonModes"] {
	if (!input || typeof input !== "object") return {};
	const output: AdaptivePracticeSettings["providerJsonModes"] = {};
	for (const [key, value] of Object.entries(
		input as Record<string, unknown>,
	)) {
		if (
			key in LLM_PROVIDER_LABELS &&
			(value === "json_schema" ||
				value === "json_object" ||
				value === "prompt_only")
		) {
			output[key as keyof AdaptivePracticeSettings["providerJsonModes"]] =
				value;
		}
	}
	return output;
}

function normalizeProviderBooleans(
	input: unknown,
): AdaptivePracticeSettings["providerSupportsImages"] {
	if (!input || typeof input !== "object") return {};
	const output: AdaptivePracticeSettings["providerSupportsImages"] = {};
	for (const [key, value] of Object.entries(
		input as Record<string, unknown>,
	)) {
		if (key in LLM_PROVIDER_LABELS && typeof value === "boolean") {
			output[
				key as keyof AdaptivePracticeSettings["providerSupportsImages"]
			] = value;
		}
	}
	return output;
}

function clamp(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
