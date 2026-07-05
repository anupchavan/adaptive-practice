import { App, DropdownComponent, PluginSettingTab, SecretComponent, Setting, TextComponent } from "obsidian";
import type AdaptivePracticePlugin from "./main";
import {
	LlmProvider,
	LLM_PROVIDER_LABELS,
	OPENAI_COMPATIBLE_PROVIDERS,
	ProviderPreset,
	PROVIDER_PRESETS,
} from "./types";
import { FilterBuilder } from "./filters/builder";
import {
	setProviderSecretName,
	syncLegacySecretName,
} from "./practice/provider-secrets";
import { setProviderModelOverride } from "./practice/provider-models";
import {
	CUSTOM_MODEL_OPTION,
	modelDropdownOptions,
} from "./practice/model-suggestions";

const ALL_PROVIDERS = Object.keys(LLM_PROVIDER_LABELS) as LlmProvider[];

/**
 * Local shapes for the 1.13 declarative settings API (Path B dual support:
 * the installed typings predate 1.13, so the surface is typed here). On
 * 1.13+ Obsidian calls getSettingDefinitions() — declarative, searchable —
 * and ignores display(); older versions call display(). Every setting must
 * exist in BOTH paths; keep them in sync when adding or changing one.
 */
interface SettingControl {
	type: string;
	key: string;
	placeholder?: string;
	options?: Record<string, string>;
	min?: number;
	max?: number;
	step?: number;
}

interface SettingDefinition {
	name?: string;
	desc?: string;
	/** For type "group": the section heading text. */
	heading?: string;
	type?: string;
	items?: SettingDefinition[];
	control?: SettingControl;
	render?: (setting: Setting) => void | (() => void);
	action?: () => void;
	visible?: () => boolean;
}

export class AdaptivePracticeSettingTab extends PluginSettingTab {
	plugin: AdaptivePracticePlugin;
	/** Providers whose model dropdown is currently on "Custom…". Transient. */
	private customModel = new Set<LlmProvider>();

	constructor(app: App, plugin: AdaptivePracticePlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.seedCustomModelState();
	}

	private seedCustomModelState(): void {
		for (const provider of ALL_PROVIDERS) {
			const override = this.plugin.settings.providerModels[provider];
			if (
				override &&
				!modelDropdownOptions(provider, PROVIDER_PRESETS[provider].model).includes(override)
			) {
				this.customModel.add(provider);
			}
		}
	}

	private currentModelSelection(provider: LlmProvider): string {
		const preset = PROVIDER_PRESETS[provider];
		const override = this.plugin.settings.providerModels[provider];
		if (this.customModel.has(provider)) return CUSTOM_MODEL_OPTION;
		if (!override) return preset.model || CUSTOM_MODEL_OPTION;
		return modelDropdownOptions(provider, preset.model).includes(override)
			? override
			: CUSTOM_MODEL_OPTION;
	}

	private async applyModelSelection(provider: LlmProvider, value: string): Promise<void> {
		const preset = PROVIDER_PRESETS[provider];
		if (value === CUSTOM_MODEL_OPTION) {
			this.customModel.add(provider);
		} else {
			this.customModel.delete(provider);
			setProviderModelOverride(
				this.plugin.settings.providerModels,
				provider,
				value === preset.model ? "" : value
			);
			await this.plugin.saveSettings();
		}
	}

	private async applyCustomModel(provider: LlmProvider, value: string): Promise<void> {
		setProviderModelOverride(this.plugin.settings.providerModels, provider, value);
		await this.plugin.saveSettings();
	}

	// ── Declarative path (Obsidian 1.13+) ────────────────────────────────

	getSettingDefinitions(): SettingDefinition[] {
		return [
			{
				desc: "This plugin sends note content to a model provider to generate practice questions. Your API key is stored in Obsidian's secret storage.",
			},
			{
				name: "Model provider",
				desc: "Provider used to generate questions.",
				control: {
					type: "dropdown",
					key: "llmProvider",
					options: Object.fromEntries(
						ALL_PROVIDERS.map((provider) => [provider, LLM_PROVIDER_LABELS[provider]])
					),
				},
			},
			...ALL_PROVIDERS.flatMap((provider) => this.providerDefinitions(provider)),
			{
				name: "Practice folder",
				desc: "Only notes in this folder appear as topics. Leave empty to use the entire vault.",
				control: { type: "folder", key: "practiceFolder", placeholder: "Topics" },
			},
			{
				name: "Default question count",
				desc: "Pre-filled when starting a session.",
				control: { type: "slider", key: "defaultQuestionCount", min: 5, max: 30, step: 1 },
			},
			{
				type: "group",
				heading: "Note dates",
				items: [
					{
						name: "Created date properties",
						desc: "Frontmatter properties preferred over file creation time for daily scheduling, comma-separated.",
						control: { type: "text", key: "createdDateProperties", placeholder: "Created, date created" },
					},
					{
						name: "Updated date properties",
						desc: "Frontmatter properties preferred over file modified time for changed-note review, comma-separated.",
						control: { type: "text", key: "updatedDateProperties", placeholder: "Updated, modified" },
					},
				],
			},
			{
				type: "group",
				heading: "Note filters",
				items: [
					{
						desc: "Conditions on properties, tags, or folders that narrow which notes appear as topics, applied in addition to the practice folder.",
					},
					{
						render: (setting) => this.renderFilterRules(setting.settingEl),
					},
				],
			},
			{
				type: "group",
				heading: "Practice view",
				items: [
					{
						name: "Question navigation side",
						desc: "Side of the practice tab that shows question navigation and session stats.",
						control: {
							type: "dropdown",
							key: "questionPaneSide",
							options: { left: "Left", right: "Right" },
						},
					},
				],
			},
			{
				type: "group",
				heading: "Daily practice",
				items: [
					{
						name: "Daily reminder",
						desc: "Show a practice reminder once per day at the set time.",
						control: { type: "toggle", key: "dailyPracticeEnabled" },
					},
					{
						name: "Reminder time",
						desc: "Local time for the reminder, as HH:MM.",
						control: { type: "text", key: "dailyReminderTime", placeholder: "18:00" },
						visible: () => this.plugin.settings.dailyPracticeEnabled,
					},
					{
						name: "Questions per daily session",
						control: { type: "slider", key: "dailyQuestionCount", min: 3, max: 20, step: 1 },
					},
					{
						name: "Notes per daily session",
						desc: "Sessions blend due reviews with new notes; notes that don't fit stay due and return the next day. Higher limits send more note content per session.",
						control: { type: "slider", key: "dailyTopicLimit", min: 1, max: 30, step: 1 },
					},
				],
			},
			{
				type: "group",
				heading: "Generation",
				items: [
					{
						name: "Adaptive flow",
						desc: "Generate in small batches that adapt to your answers, holding difficulty near an 80% success rate. Turn off to generate every question up front.",
						control: { type: "toggle", key: "flowGeneration" },
					},
					{
						name: "Verify answers",
						desc: "Blind re-solve each batch and drop questions whose marked answer fails the check. Costs about one extra request per batch.",
						control: { type: "toggle", key: "verifyAnswers" },
					},
					{
						name: "Deep authoring",
						desc: "Adversarially rewrite medium and hard questions: attack shortcuts, weak traps, and giveaways, then sharpen. Noticeably better questions at roughly double the tokens.",
						control: { type: "toggle", key: "deepAuthoring" },
					},
					{
						name: "Practice intent",
						desc: "Mastery favors understanding and transfer, exam cram favors high-yield facts and classic traps, review favors quick checks across many subtopics.",
						control: {
							type: "dropdown",
							key: "practiceIntent",
							options: { mastery: "Durable mastery", cram: "Exam cram", review: "Broad review" },
						},
					},
					{
						name: "Review intensity",
						desc: "How well you want to remember a note when it comes due. Higher means shorter gaps and more frequent reviews.",
						control: {
							type: "dropdown",
							key: "targetRetention",
							options: {
								"0.8": "Relaxed (80% recall)",
								"0.85": "Light (85% recall)",
								"0.9": "Standard (90% recall)",
								"0.95": "Intensive (95% recall)",
							},
						},
					},
					{
						name: "Practice plan",
						desc: "Refresh the vault skeleton used for daily topic selection.",
						action: () => {
							void this.plugin.refreshPracticePlan(true);
						},
					},
				],
			},
		];
	}

	private providerDefinitions(provider: LlmProvider): SettingDefinition[] {
		const preset = PROVIDER_PRESETS[provider];
		const active = (): boolean => this.plugin.settings.llmProvider === provider;
		const definitions: SettingDefinition[] = [
			{
				name: `${LLM_PROVIDER_LABELS[provider]} API key`,
				desc: `Obsidian secret that stores this provider key. Default: ${preset.secretName}.`,
				visible: active,
				render: (setting) => this.renderSecretControl(setting, provider),
			},
			{
				name: "Model",
				desc: "Model used for question generation.",
				visible: active,
				control: {
					type: "dropdown",
					key: `providerModel.${provider}`,
					options: this.modelOptionRecord(provider),
				},
			},
			{
				name: "Custom model",
				desc: "Exact model name sent to the provider.",
				visible: () => active() && this.currentModelSelection(provider) === CUSTOM_MODEL_OPTION,
				control: {
					type: "text",
					key: `providerCustomModel.${provider}`,
					placeholder: preset.model || "model-name",
				},
			},
		];
		if (OPENAI_COMPATIBLE_PROVIDERS.includes(provider)) {
			definitions.push(
				{
					name: "Base URL",
					desc:
						provider === "openai"
							? "Responses API endpoint or API root. Roots ending in /v1 are expanded automatically."
							: "Chat completions endpoint or compatible API root. Roots ending in /v1 are expanded automatically.",
					visible: active,
					control: { type: "text", key: `providerBaseUrl.${provider}`, placeholder: preset.baseUrl },
				},
				{
					name: "JSON mode",
					desc: "Use the strongest response format the endpoint supports.",
					visible: active,
					control: {
						type: "dropdown",
						key: `providerJsonMode.${provider}`,
						options: {
							json_schema: "JSON schema",
							json_object: "JSON object",
							prompt_only: "Prompt only",
						},
					},
				},
				{
					name: "Send image attachments",
					desc: "Attach embedded images when the endpoint supports vision input.",
					visible: active,
					control: { type: "toggle", key: `providerSupportsImages.${provider}` },
				}
			);
		}
		return definitions;
	}

	private modelOptionRecord(provider: LlmProvider): Record<string, string> {
		const preset = PROVIDER_PRESETS[provider];
		const record: Record<string, string> = {};
		for (const model of modelDropdownOptions(provider, preset.model)) {
			record[model] = model === preset.model ? `${model} (default)` : model;
		}
		record[CUSTOM_MODEL_OPTION] = "Custom…";
		return record;
	}

	/** Declarative custom storage for keys that are nested or typed. */
	getControlValue(key: string): unknown {
		if (key === "targetRetention") {
			return String(this.plugin.settings.targetRetention || 0.9);
		}
		const [prefix, provider] = key.split(".") as [string, LlmProvider];
		switch (prefix) {
			case "providerModel":
				return this.currentModelSelection(provider);
			case "providerCustomModel":
				return this.plugin.settings.providerModels[provider] ?? "";
			case "providerBaseUrl":
				return this.plugin.settings.providerBaseUrls[provider] || PROVIDER_PRESETS[provider].baseUrl;
			case "providerJsonMode":
				return this.plugin.settings.providerJsonModes[provider] || PROVIDER_PRESETS[provider].jsonMode;
			case "providerSupportsImages":
				return (
					this.plugin.settings.providerSupportsImages[provider] ??
					PROVIDER_PRESETS[provider].supportsImages
				);
			default:
				return (this.plugin.settings as unknown as Record<string, unknown>)[key];
		}
	}

	setControlValue(key: string, value: unknown): void {
		if (key === "targetRetention") {
			this.plugin.settings.targetRetention = Number(value) || 0.9;
			void this.plugin.saveSettings();
			return;
		}
		if (key === "llmProvider") {
			this.plugin.settings.llmProvider = value as LlmProvider;
			syncLegacySecretName(this.plugin.settings);
			void this.plugin.saveSettings();
			return;
		}
		const [prefix, provider] = key.split(".") as [string, LlmProvider];
		switch (prefix) {
			case "providerModel":
				void this.applyModelSelection(provider, String(value));
				return;
			case "providerCustomModel":
				void this.applyCustomModel(provider, String(value));
				return;
			case "providerBaseUrl":
				this.plugin.settings.providerBaseUrls[provider] = String(value).trim();
				break;
			case "providerJsonMode":
				this.plugin.settings.providerJsonModes[provider] = value as ProviderPreset["jsonMode"];
				break;
			case "providerSupportsImages":
				this.plugin.settings.providerSupportsImages[provider] = Boolean(value);
				break;
			default:
				(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		}
		void this.plugin.saveSettings();
	}

	private renderSecretControl(setting: Setting, provider: LlmProvider): void {
		const defaultSecret = PROVIDER_PRESETS[provider].secretName;
		setting.addComponent((el: HTMLElement) =>
			new SecretComponent(this.app, el)
				.setValue(this.plugin.getSecretId())
				.onChange(async (value: string) => {
					setProviderSecretName(
						this.plugin.settings,
						provider,
						value || defaultSecret
					);
					syncLegacySecretName(this.plugin.settings);
					await this.plugin.saveSettings();
				})
		);
	}

	private renderFilterRules(container: HTMLElement): void {
		container.empty();
		container.addClass("ap-bases-query-container");
		const builder = new FilterBuilder(
			this.app,
			this.plugin.settings.filterRules,
			() => { void this.plugin.saveSettings(); },
			() => { container.empty(); builder.render(container); }
		);
		builder.render(container);
	}

	// ── Imperative path (Obsidian < 1.13) ────────────────────────────────

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.seedCustomModelState();

		containerEl.createEl("p", {
			text: "This plugin sends note content to a model provider to generate practice questions. Your API key is stored in Obsidian's secret storage.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Model provider")
			.setDesc("Provider used to generate questions.")
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(LLM_PROVIDER_LABELS)) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.plugin.settings.llmProvider);
				dropdown.onChange(async (value) => {
					this.plugin.settings.llmProvider = value as LlmProvider;
					syncLegacySecretName(this.plugin.settings);
					await this.plugin.saveSettings();
					this.display();
				});
			});

		const provider = this.plugin.settings.llmProvider;
		const preset = PROVIDER_PRESETS[provider];

		const secretSetting = new Setting(containerEl)
			.setName(`${LLM_PROVIDER_LABELS[provider]} API key`)
			.setDesc(`Obsidian secret that stores this provider key. Default: ${preset.secretName}.`);
		this.renderSecretControl(secretSetting, provider);

		this.renderModelSettings(containerEl, provider, preset);

		new Setting(containerEl)
			.setName("Practice folder")
			.setDesc("Only notes in this folder appear as topics. Leave empty to use the entire vault.")
			.addText((text) =>
				text
					.setPlaceholder("Topics")
					.setValue(this.plugin.settings.practiceFolder)
					.onChange(async (value) => {
						this.plugin.settings.practiceFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default question count")
			.setDesc("Pre-filled when starting a session.")
			.addSlider((slider) =>
				slider
					.setLimits(5, 30, 1)
					.setValue(this.plugin.settings.defaultQuestionCount)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.defaultQuestionCount = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Note dates").setHeading();

		new Setting(containerEl)
			.setName("Created date properties")
			.setDesc("Frontmatter properties preferred over file creation time for daily scheduling, comma-separated.")
			.addText((text) =>
				text
					.setPlaceholder("Created, date created")
					.setValue(this.plugin.settings.createdDateProperties)
					.onChange(async (value) => {
						this.plugin.settings.createdDateProperties = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Updated date properties")
			.setDesc("Frontmatter properties preferred over file modified time for changed-note review, comma-separated.")
			.addText((text) =>
				text
					.setPlaceholder("Updated, modified")
					.setValue(this.plugin.settings.updatedDateProperties)
					.onChange(async (value) => {
						this.plugin.settings.updatedDateProperties = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Note filters").setHeading();
		containerEl.createEl("p", {
			text: "Conditions on properties, tags, or folders that narrow which notes appear as topics, applied in addition to the practice folder.",
			cls: "setting-item-description",
		});
		this.renderFilterRules(containerEl.createDiv());

		new Setting(containerEl).setName("Practice view").setHeading();

		new Setting(containerEl)
			.setName("Question navigation side")
			.setDesc("Side of the practice tab that shows question navigation and session stats.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("left", "Left")
					.addOption("right", "Right")
					.setValue(this.plugin.settings.questionPaneSide)
					.onChange(async (value) => {
						this.plugin.settings.questionPaneSide = value === "right" ? "right" : "left";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Daily practice").setHeading();

		new Setting(containerEl)
			.setName("Daily reminder")
			.setDesc("Show a practice reminder once per day at the set time.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dailyPracticeEnabled)
					.onChange(async (value) => {
						this.plugin.settings.dailyPracticeEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Reminder time")
			.setDesc("Local time for the reminder.")
			.addText((text) => {
				text.inputEl.type = "time";
				text
					.setValue(this.plugin.settings.dailyReminderTime)
					.onChange(async (value) => {
						this.plugin.settings.dailyReminderTime = value || "18:00";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Questions per daily session")
			.addSlider((slider) =>
				slider
					.setLimits(3, 20, 1)
					.setValue(this.plugin.settings.dailyQuestionCount)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.dailyQuestionCount = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Notes per daily session")
			.setDesc("Sessions blend due reviews with new notes; notes that don't fit stay due and return the next day. Higher limits send more note content per session.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 30, 1)
					.setValue(this.plugin.settings.dailyTopicLimit)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.dailyTopicLimit = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Generation").setHeading();

		new Setting(containerEl)
			.setName("Adaptive flow")
			.setDesc("Generate in small batches that adapt to your answers, holding difficulty near an 80% success rate. Turn off to generate every question up front.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.flowGeneration);
				toggle.onChange(async (value) => {
					this.plugin.settings.flowGeneration = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Verify answers")
			.setDesc("Blind re-solve each batch and drop questions whose marked answer fails the check. Costs about one extra request per batch.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.verifyAnswers);
				toggle.onChange(async (value) => {
					this.plugin.settings.verifyAnswers = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Deep authoring")
			.setDesc("Adversarially rewrite medium and hard questions: attack shortcuts, weak traps, and giveaways, then sharpen. Noticeably better questions at roughly double the tokens.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.deepAuthoring);
				toggle.onChange(async (value) => {
					this.plugin.settings.deepAuthoring = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Practice intent")
			.setDesc("Mastery favors understanding and transfer, exam cram favors high-yield facts and classic traps, review favors quick checks across many subtopics.")
			.addDropdown((dropdown) => {
				dropdown.addOption("mastery", "Durable mastery");
				dropdown.addOption("cram", "Exam cram");
				dropdown.addOption("review", "Broad review");
				dropdown.setValue(this.plugin.settings.practiceIntent);
				dropdown.onChange(async (value) => {
					this.plugin.settings.practiceIntent =
						value === "cram" || value === "review" ? value : "mastery";
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Review intensity")
			.setDesc("How well you want to remember a note when it comes due. Higher means shorter gaps and more frequent reviews.")
			.addDropdown((dropdown) => {
				dropdown.addOption("0.8", "Relaxed (80% recall)");
				dropdown.addOption("0.85", "Light (85% recall)");
				dropdown.addOption("0.9", "Standard (90% recall)");
				dropdown.addOption("0.95", "Intensive (95% recall)");
				dropdown.setValue(String(this.plugin.settings.targetRetention || 0.9));
				dropdown.onChange(async (value) => {
					this.plugin.settings.targetRetention = Number(value) || 0.9;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Practice plan")
			.setDesc("Refresh the vault skeleton used for daily topic selection.")
			.addButton((button) =>
				button
					.setButtonText("Scan now")
					.onClick(async () => {
						await this.plugin.refreshPracticePlan(true);
					})
			);
	}

	private renderModelSettings(
		containerEl: HTMLElement,
		provider: LlmProvider,
		preset: ProviderPreset
	): void {
		let customText: TextComponent | null = null;
		let customSetting: Setting | null = null;
		const syncCustomVisibility = (): void => {
			customSetting?.settingEl.toggleClass(
				"ap-hidden",
				this.currentModelSelection(provider) !== CUSTOM_MODEL_OPTION
			);
		};

		new Setting(containerEl)
			.setName("Model")
			.setDesc("Model used for question generation.")
			.addDropdown((dropdown: DropdownComponent) => {
				for (const [value, label] of Object.entries(this.modelOptionRecord(provider))) {
					dropdown.addOption(value, label);
				}
				dropdown.setValue(this.currentModelSelection(provider));
				dropdown.onChange(async (value) => {
					await this.applyModelSelection(provider, value);
					if (value === CUSTOM_MODEL_OPTION) {
						customText?.setValue(this.plugin.settings.providerModels[provider] ?? "");
					}
					syncCustomVisibility();
				});
			});

		customSetting = new Setting(containerEl)
			.setName("Custom model")
			.setDesc("Exact model name sent to the provider.")
			.addText((text) => {
				customText = text;
				text
					.setPlaceholder(preset.model || "model-name")
					.setValue(this.plugin.settings.providerModels[provider] ?? "")
					.onChange(async (value) => {
						await this.applyCustomModel(provider, value);
					});
			});
		syncCustomVisibility();

		if (!OPENAI_COMPATIBLE_PROVIDERS.includes(provider)) return;
		const baseUrlDescription = provider === "openai"
			? "Responses API endpoint or API root. Roots ending in /v1 are expanded automatically."
			: "Chat completions endpoint or compatible API root. Roots ending in /v1 are expanded automatically.";

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc(baseUrlDescription)
			.addText((text) =>
				text
					.setPlaceholder(preset.baseUrl)
					.setValue(this.plugin.settings.providerBaseUrls[provider] || preset.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.providerBaseUrls[provider] = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("JSON mode")
			.setDesc("Use the strongest response format the endpoint supports.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("json_schema", "JSON schema")
					.addOption("json_object", "JSON object")
					.addOption("prompt_only", "Prompt only")
					.setValue(this.plugin.settings.providerJsonModes[provider] || preset.jsonMode)
					.onChange(async (value) => {
						this.plugin.settings.providerJsonModes[provider] =
							value as ProviderPreset["jsonMode"];
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Send image attachments")
			.setDesc("Attach embedded images when the endpoint supports vision input.")
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.settings.providerSupportsImages[provider] ??
						preset.supportsImages
					)
					.onChange(async (value) => {
						this.plugin.settings.providerSupportsImages[provider] = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
