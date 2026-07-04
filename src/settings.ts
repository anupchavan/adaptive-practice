import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
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

export class AdaptivePracticeSettingTab extends PluginSettingTab {
	plugin: AdaptivePracticePlugin;

	constructor(app: App, plugin: AdaptivePracticePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			text: "This plugin sends note content to a model provider to generate practice questions. Your API key is stored securely using Obsidian\u2019s secret storage.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Model provider")
			.setDesc("Choose which provider to use for generating questions.")
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

		const providerLabel = LLM_PROVIDER_LABELS[this.plugin.settings.llmProvider];
		const preset = PROVIDER_PRESETS[this.plugin.settings.llmProvider];
		const defaultSecret = preset.secretName;

		new Setting(containerEl)
			.setName(`${providerLabel} API key`)
			.setDesc(`Select or create the Obsidian secret that stores this provider key. Default: ${defaultSecret}.`)
			.addComponent((el) =>
				new SecretComponent(this.app, el)
					.setValue(this.plugin.getSecretId())
					.onChange(async (value) => {
						setProviderSecretName(
							this.plugin.settings,
							this.plugin.settings.llmProvider,
							value || defaultSecret
						);
						syncLegacySecretName(this.plugin.settings);
						await this.plugin.saveSettings();
					})
			);

		this.renderProviderModelSettings(containerEl);

		new Setting(containerEl)
			.setName("Practice folder")
			.setDesc(
				"Only notes inside this folder will appear as topics. Leave empty to use the entire vault."
			)
			.addText((text) =>
				text
					.setPlaceholder("Topics")
					.setValue(this.plugin.settings.practiceFolder)
					.onChange(async (value) => {
						this.plugin.settings.practiceFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Note dates").setHeading();

		new Setting(containerEl)
			.setName("Created date properties")
			.setDesc("Comma-separated frontmatter property names to prefer over file creation time for daily scheduling.")
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
			.setDesc("Comma-separated frontmatter property names to prefer over file modified time for changed-note daily review.")
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
			text: "Optionally filter which notes appear as topics using conditions on properties, tags, folders, etc. These are applied in addition to the practice folder above.",
			cls: "setting-item-description",
		});

		const rulesContainer = containerEl.createDiv({ cls: "ap-bases-query-container" });
		const builder = new FilterBuilder(
			this.app,
			this.plugin.settings.filterRules,
			() => { void this.plugin.saveSettings(); },
			() => { rulesContainer.empty(); builder.render(rulesContainer); }
		);
		builder.render(rulesContainer);

		new Setting(containerEl)
			.setName("Default number of questions")
			.setDesc("Pre-filled question count when starting a session (5\u201330).")
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

		new Setting(containerEl).setName("Practice view").setHeading();

		new Setting(containerEl)
			.setName("Question number pane")
			.setDesc("Choose which side of the full-tab practice view shows question navigation and session stats.")
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
			.setDesc("Show a practice reminder once per day at the selected local time.")
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
			.setDesc("Local time for the daily practice reminder.")
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
			.setName("Daily questions")
			.setDesc("How many questions to generate for a daily session (3\u201320).")
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
			.setName("Daily topic limit")
			.setDesc("Maximum number of due notes to mix into one daily session.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 12, 1)
					.setValue(this.plugin.settings.dailyTopicLimit)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.dailyTopicLimit = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Practice intent")
			.setDesc("What you are practicing for. Mastery favors understanding and transfer; exam cram favors high-yield facts and classic traps; review favors quick checks across many subtopics.")
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
			.setDesc("How well you want to remember a note when it comes due again. Higher means shorter gaps and more frequent reviews; lower means fewer reviews with harder recall.")
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

	private renderProviderModelSettings(containerEl: HTMLElement): void {
		const provider = this.plugin.settings.llmProvider;
		if (
			provider !== "gemini" &&
			provider !== "anthropic" &&
			!OPENAI_COMPATIBLE_PROVIDERS.includes(provider)
		) {
			return;
		}
		const preset = PROVIDER_PRESETS[provider];

		new Setting(containerEl)
			.setName("Model")
			.setDesc(`Model name sent to ${LLM_PROVIDER_LABELS[provider]}.`)
			.addText((text) =>
				text
					.setPlaceholder(preset.model || "model-name")
					.setValue(this.plugin.settings.providerModels[provider] || preset.model)
					.onChange(async (value) => {
						setProviderModelOverride(
							this.plugin.settings.providerModels,
							provider,
							value
						);
						await this.plugin.saveSettings();
					})
			)
			.addButton((button) =>
				button
					.setButtonText("Use default")
					.setTooltip(`Use ${preset.model || "the provider default"}`)
					.setDisabled(!this.plugin.settings.providerModels[provider])
					.onClick(async () => {
						delete this.plugin.settings.providerModels[provider];
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (provider === "gemini" || provider === "anthropic") return;
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
			.setDesc("Use the strongest response-format option your endpoint supports.")
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
			.setDesc("Attach embedded images when this endpoint supports vision input. Document attachments require a provider with document support.")
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
