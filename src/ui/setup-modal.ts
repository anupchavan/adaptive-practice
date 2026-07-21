import { ensureVaultSkills } from "../notes/vault-file";
import {
	App,
	Modal,
	Notice,
	SearchComponent,
	Setting,
	TFile,
} from "obsidian";
import {
	AdaptivePracticeSettings,
	DEFAULT_FILTER_RULES,
	FilterGroup,
	SessionConfig,
	TopicNote,
} from "../types";
import { frontmatterRecord } from "../notes/frontmatter";
import { getTopicNotes, getTopicNotesWithFilters } from "../notes/reader";
import { FilterBuilder } from "../filters/builder";
import { applyPracticeMemoryToTopics } from "../practice/scheduler";
import { getProviderPdfWarning } from "../practice/provider-capabilities";
import { folderLabel, stringifyGroupValue } from "./topic-groups";

type TopicQuickFilter = "all" | "due" | "new" | "low" | "pdf";

const MAX_RENDERED_TOPICS = 300;

export class SetupModal extends Modal {
	private settings: AdaptivePracticeSettings;
	private onStart: (config: SessionConfig) => void;
	private preselectedPath: string | null;

	private selectedPaths = new Set<string>();
	private questionCount: number;
	private allTopics: TopicNote[] = [];
	private useFilter = false;
	private sessionFilterRules: FilterGroup;
	private searchQuery = "";
	private quickFilter: TopicQuickFilter = "all";
	private groupFilter = "all";
	private topicGroups = new Map<string, string>();

	constructor(
		app: App,
		settings: AdaptivePracticeSettings,
		onStart: (config: SessionConfig) => void,
		preselectedPath?: string,
	) {
		super(app);
		this.settings = settings;
		this.onStart = onStart;
		this.preselectedPath = preselectedPath ?? null;
		this.questionCount = settings.defaultQuestionCount;
		this.sessionFilterRules = JSON.parse(
			JSON.stringify(DEFAULT_FILTER_RULES),
		) as FilterGroup;
	}

	onOpen(): void {
		void ensureVaultSkills(this.app);
		const { contentEl } = this;
		contentEl.empty();

		this.setTitle("Start practice session");
		this.modalEl.addClass("mod-ap");

		this.allTopics = applyPracticeMemoryToTopics(
			getTopicNotes(
				this.app,
				this.settings.practiceFolder,
				this.settings.pdfSkills,
				this.settings.filterRules,
				this.settings,
			),
			this.settings.practiceMemory,
		).sort(compareTopicsForPicker);
		this.topicGroups = new Map();

		if (this.allTopics.length === 0 && !this.useFilter) {
			contentEl.createEl("p", {
				text: "No notes found in the configured practice folder.",
				cls: "ap-empty-state",
			});
		}

		if (this.preselectedPath) {
			this.selectedPaths.add(this.preselectedPath);
		}

		new Setting(contentEl)
			.setName("Use filters to select topics")
			.setDesc(
				"Build filter conditions to select topics instead of picking manually.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.useFilter).onChange((val) => {
					this.useFilter = val;
					this.renderTopicSection(topicSection);
				}),
			);

		const topicSection = contentEl.createDiv({ cls: "ap-topic-section" });
		this.renderTopicSection(topicSection);

		new Setting(contentEl)
			.setName("Number of questions")
			.addSlider((slider) =>
				slider
					.setLimits(5, 30, 1)
					.setValue(this.questionCount)
					.setDynamicTooltip()
					.onChange((v) => {
						this.questionCount = v;
					}),
			);

		contentEl.createDiv("modal-button-container", (el) => {
			el.createEl(
				"button",
				{ cls: "mod-cta", text: "Start practice" },
				(el) => {
					el.addEventListener("click", () => {
						let topics: TopicNote[];
						if (this.useFilter) {
							topics = applyPracticeMemoryToTopics(
								getTopicNotesWithFilters(
									this.app,
									this.sessionFilterRules,
									this.settings.pdfSkills,
									this.settings,
								),
								this.settings.practiceMemory,
							);
							if (topics.length === 0) {
								new Notice(
									"No notes match the current filters.",
								);
								return;
							}
						} else {
							if (this.selectedPaths.size === 0) {
								new Notice("Select at least one topic.");
								return;
							}
							topics = this.allTopics.filter((t) =>
								this.selectedPaths.has(t.path),
							);
						}
						const warning = getProviderPdfWarning(
							this.settings.llmProvider,
							topics,
						);
						if (warning) {
							new Notice(warning);
							return;
						}
						this.close();
						this.onStart({
							topics,
							questionCount: this.questionCount,
						});
					});
				},
			);
		});
	}

	private renderTopicSection(container: HTMLElement): void {
		container.empty();

		if (this.useFilter) {
			new Setting(container);
			const rulesContainer = container.createDiv({
				cls: "ap-bases-query-container",
			});
			const builder = new FilterBuilder(
				this.app,
				this.sessionFilterRules,
				() => {
					this.updateFilterPreview(container);
				},
				() => {
					rulesContainer.empty();
					builder.render(rulesContainer);
					this.updateFilterPreview(container);
				},
			);
			builder.render(rulesContainer);
			this.updateFilterPreview(container);
		} else {
			// Hotkeys-panel look. Rows and inputs come from the official
			// components (Setting, SearchComponent, DropdownComponent), which
			// emit the native classes themselves; only the wrapper and the
			// filter chips have no component, so they carry the classes by hand.
			const groupEl = container.createDiv({
				cls: "setting-group mod-list ap-topic-picker",
			});
			const searchRow = groupEl.createDiv({
				cls: "setting-group-search",
			});
			const search = new SearchComponent(searchRow)
				.setPlaceholder("Filter by title, alias, or path...")
				.setValue(this.searchQuery);

			const searchControl = searchRow.createDiv({
				cls: "setting-group-search-control",
			});
			const filterBar = searchControl.createDiv({
				cls: "setting-group-filters",
			});
			const filters: Array<{ id: TopicQuickFilter; label: string }> = [
				{ id: "all", label: "All" },
				{ id: "due", label: "Due" },
				{ id: "new", label: "New" },
				{ id: "low", label: "Low skill" },
				{ id: "pdf", label: "PDFs" },
			];
			for (const filter of filters) {
				const chip = filterBar.createDiv({
					text: filter.label,
					cls: "setting-group-filter",
				});
				chip.tabIndex = 0;
				if (this.quickFilter === filter.id) {
					chip.addClass("is-active");
				}
				chip.addEventListener("click", () => {
					this.quickFilter = filter.id;
					this.renderTopicSection(container);
				});
			}

			const rightCluster = searchControl.createDiv({
				cls: "ap-topic-select-cluster",
			});
			const summaryEl = rightCluster.createDiv({
				cls: "ap-topic-summary",
			});
			const selectAllLabel = rightCluster.createEl("label", {
				cls: "ap-select-all",
			});
			const selectAllCheckbox = selectAllLabel.createEl("input", {
				type: "checkbox",
			});
			selectAllLabel.createEl("span", { text: "Select visible" });

			const listHost = groupEl.createDiv({ cls: "setting-items" });

			selectAllCheckbox.addEventListener("change", () => {
				const checked = selectAllCheckbox.checked;
				for (const topic of this.getVisibleTopics()) {
					if (checked) this.selectedPaths.add(topic.path);
					else this.selectedPaths.delete(topic.path);
				}
				this.renderManualTopicList(
					listHost,
					summaryEl,
					selectAllCheckbox,
				);
			});

			search.onChange((value) => {
				this.searchQuery = value;
				this.renderManualTopicList(
					listHost,
					summaryEl,
					selectAllCheckbox,
				);
			});

			this.renderManualTopicList(listHost, summaryEl, selectAllCheckbox);
		}
	}

	private renderManualTopicList(
		container: HTMLElement,
		summaryEl: HTMLElement,
		selectAllCheckbox: HTMLInputElement,
	): void {
		container.empty();
		this.updateManualSelectionSummary(summaryEl, selectAllCheckbox);

		const visibleTopics = this.getVisibleTopics();
		const renderedTopics = visibleTopics.slice(0, MAX_RENDERED_TOPICS);

		if (visibleTopics.length === 0) {
			container.createDiv({
				text: "No topics match the current search or filter.",
				cls: "ap-empty-state",
			});
			return;
		}

		for (const topic of renderedTopics) {
			this.renderManualTopicRow(
				container,
				topic,
				summaryEl,
				selectAllCheckbox,
			);
		}

		if (visibleTopics.length > renderedTopics.length) {
			container.createDiv({
				text: `Showing ${renderedTopics.length} of ${visibleTopics.length} matches. Search or filter to narrow the list.`,
				cls: "ap-topic-list-note",
			});
		}
	}

	private renderManualTopicRow(
		container: HTMLElement,
		topic: TopicNote,
		summaryEl: HTMLElement,
		selectAllCheckbox: HTMLInputElement,
	): void {
		const aliases = displayAliases(topic);
		const setting = new Setting(container)
			.setName(topic.title)
			.setDesc(aliases ? `${topic.path} · ${aliases}` : topic.path);
		setting.settingEl.addClass("ap-topic-item");
		setting.settingEl.tabIndex = -1;

		// The one non-component piece: a leading checkbox slot (the native
		// Setting layout has no left-side control).
		const checkSlot = setting.settingEl.createDiv({
			cls: "ap-topic-check",
		});
		setting.settingEl.prepend(checkSlot);
		const checkbox = checkSlot.createEl("input", { type: "checkbox" });
		checkbox.checked = this.selectedPaths.has(topic.path);
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) this.selectedPaths.add(topic.path);
			else this.selectedPaths.delete(topic.path);
			this.updateManualSelectionSummary(summaryEl, selectAllCheckbox);
		});
		setting.settingEl.addEventListener("click", (e) => {
			if (e.target === checkbox) return;
			checkbox.checked = !checkbox.checked;
			checkbox.dispatchEvent(new Event("change"));
		});

		if (topic.isPdf) {
			setting.nameEl.createSpan({ text: "PDF", cls: "ap-pdf-badge" });
		}
		const group = this.getTopicGroup(topic);
		if (group) {
			setting.nameEl.createSpan({
				text: group,
				cls: "ap-topic-group-badge",
			});
		}

		const skillBadge = setting.controlEl.createDiv({
			cls: "ap-skill-badge",
		});
		skillBadge.setText(`${Math.round(topic.skill)}`);
		skillBadge.title = `Skill: ${Math.round(topic.skill)}/100`;
		if (topic.skill < 30) skillBadge.addClass("ap-skill-low");
		else if (topic.skill < 70) skillBadge.addClass("ap-skill-mid");
		else skillBadge.addClass("ap-skill-high");
		setting.controlEl.createDiv({
			text: this.getTopicStatusText(topic),
			cls: "ap-topic-status",
		});
	}

	private updateManualSelectionSummary(
		summaryEl: HTMLElement,
		selectAllCheckbox: HTMLInputElement,
	): void {
		const visibleTopics = this.getVisibleTopics();
		const visibleSelected = visibleTopics.filter((topic) =>
			this.selectedPaths.has(topic.path),
		).length;
		const selectedTopics = this.allTopics.filter((topic) =>
			this.selectedPaths.has(topic.path),
		);
		selectAllCheckbox.disabled = visibleTopics.length === 0;
		selectAllCheckbox.checked =
			visibleTopics.length > 0 &&
			visibleSelected === visibleTopics.length;
		selectAllCheckbox.indeterminate =
			visibleSelected > 0 && visibleSelected < visibleTopics.length;
		summaryEl.empty();
		summaryEl.createSpan({
			text: `${visibleTopics.length} match${visibleTopics.length === 1 ? "" : "es"} · ${this.selectedPaths.size} selected`,
		});
		const warning = getProviderPdfWarning(
			this.settings.llmProvider,
			selectedTopics,
		);
		if (warning) {
			summaryEl.createDiv({
				text: warning,
				cls: "ap-topic-summary-warning",
			});
		}
	}

	private getVisibleTopics(): TopicNote[] {
		const query = this.searchQuery.trim().toLowerCase();
		return this.allTopics.filter((topic) => {
			if (!this.matchesQuickFilter(topic)) return false;
			const group = this.getTopicGroup(topic);
			if (this.groupFilter !== "all" && group !== this.groupFilter)
				return false;
			if (!query) return true;
			return (
				topic.title.toLowerCase().includes(query) ||
				topic.path.toLowerCase().includes(query) ||
				group.toLowerCase().includes(query) ||
				(topic.aliases ?? []).some((alias) =>
					alias.toLowerCase().includes(query),
				)
			);
		});
	}

	private getTopicGroupOptions(): string[] {
		const groups = new Set<string>();
		for (const topic of this.allTopics) {
			const group = this.getTopicGroup(topic);
			if (group) groups.add(group);
		}
		return [...groups].sort((a, b) => a.localeCompare(b));
	}

	private getTopicGroup(topic: TopicNote): string {
		const cached = this.topicGroups.get(topic.path);
		if (cached !== undefined) return cached;

		const indexCourse =
			this.settings.practiceMemory.index[topic.path]?.frontmatter.course;
		const file = this.app.vault.getAbstractFileByPath(topic.path);
		const cache =
			file instanceof TFile
				? this.app.metadataCache.getFileCache(file)
				: null;
		const frontmatter = frontmatterRecord(cache);
		const rawCourse = indexCourse || frontmatter?.["course"];
		const course = stringifyGroupValue(rawCourse);
		const group = course || folderLabel(topic.path);
		this.topicGroups.set(topic.path, group);
		return group;
	}

	private matchesQuickFilter(topic: TopicNote): boolean {
		const state = this.settings.practiceMemory.notes[topic.path];
		switch (this.quickFilter) {
			case "due":
				return isTopicDue(topic);
			case "new":
				return !state || state.attempts === 0;
			case "low":
				return topic.skill < 55;
			case "pdf":
				return topic.isPdf;
			case "all":
			default:
				return true;
		}
	}

	private getTopicStatusText(topic: TopicNote): string {
		const state = this.settings.practiceMemory.notes[topic.path];
		const bits: string[] = [];
		if (!state || state.attempts === 0) bits.push("new");
		bits.push(formatDueText(topic.dueAt));
		if (topic.skill < 55) bits.push("low skill");
		return bits.join(" · ");
	}

	private updateFilterPreview(container: HTMLElement): void {
		let preview =
			container.querySelector<HTMLElement>(".ap-filter-preview");
		if (!preview) {
			preview = container.createDiv({ cls: "ap-filter-preview" });
		}
		const matched = getTopicNotesWithFilters(
			this.app,
			this.sessionFilterRules,
			this.settings.pdfSkills,
			this.settings,
		);
		preview.empty();
		preview.createEl("span", {
			text: `${matched.length} note${matched.length !== 1 ? "s" : ""} matched`,
			cls:
				matched.length > 0
					? "ap-filter-match-count"
					: "ap-filter-match-count ap-filter-no-match",
		});
		const warning = getProviderPdfWarning(
			this.settings.llmProvider,
			matched,
		);
		if (warning) {
			preview.createDiv({
				text: warning,
				cls: "ap-topic-summary-warning",
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function compareTopicsForPicker(a: TopicNote, b: TopicNote): number {
	const dueDiff = Number(isTopicDue(b)) - Number(isTopicDue(a));
	if (dueDiff !== 0) return dueDiff;
	const skillDiff = a.skill - b.skill;
	if (skillDiff !== 0) return skillDiff;
	return a.title.localeCompare(b.title);
}

function isTopicDue(topic: TopicNote): boolean {
	return !topic.dueAt || topic.dueAt <= Date.now();
}

function formatDueText(dueAt: number | undefined): string {
	if (!dueAt) return "due now";
	const diffMs = dueAt - Date.now();
	if (diffMs <= 0) return "due now";
	const diffHours = Math.ceil(diffMs / (60 * 60 * 1000));
	if (diffHours < 24) return `due in ${diffHours}h`;
	const diffDays = Math.ceil(diffHours / 24);
	return `due in ${diffDays}d`;
}

function displayAliases(topic: TopicNote): string {
	const aliases = (topic.aliases ?? [])
		.map((alias) => alias.trim())
		.filter(Boolean)
		.slice(0, 3);
	if (aliases.length === 0) return "";
	return `Aliases: ${aliases.join(", ")}`;
}
