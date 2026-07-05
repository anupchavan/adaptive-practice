import { App, FuzzySuggestModal, FuzzyMatch, setIcon } from "obsidian";
import { FilterGroup, Filter, FilterOperator, FilterConjunction } from "../types";
import {
	FileSuggest,
	FolderSuggest,
	TagSuggest,
	PropertySuggest,
	FrontmatterValueSuggest,
	isWikilink,
	extractWikilinkTarget,
	extractWikilinkDisplay,
	openWikilinkFile,
} from "./suggests";

type PropertyType = "text" | "number" | "date" | "datetime" | "list" | "checkbox" | "file" | "unknown";

const TYPE_ICONS: Record<PropertyType, string> = {
	text: "text",
	number: "binary",
	date: "calendar",
	datetime: "clock",
	list: "list",
	checkbox: "check-square",
	file: "file",
	unknown: "text",
};

// "contains" is supported by the matcher for text values and was offered by the
// previous builder, so it stays listed to keep stored rules editable.
const TEXT_OPERATORS: string[] = ["is", "is not", "contains", "starts with", "ends with", "is empty", "contains any of", "contains all of", "does not start with", "does not end with", "is not empty", "does not contain", "does not contain any of", "does not contain all of"];

/**
 * Operator sets by type. Field-specific overrides take priority (see FIELD_OPERATORS).
 */
const TYPE_OPERATORS: Record<string, string[]> = {
	text: TEXT_OPERATORS,
	list: ["is exactly", "is not exactly", "is empty", "contains", "contains any of", "contains all of", "is not empty", "does not contain", "does not contain any of", "does not contain all of"],
	number: ["=", "≠", "<", "≤", ">", "≥", "is empty", "is not empty"],
	date: ["on", "not on", "before", "on or before", "after", "on or after", "is empty", "is not empty"],
	checkbox: ["is", "is not"],
};

/**
 * Field-specific operator overrides. These take priority over TYPE_OPERATORS.
 */
const FIELD_OPERATORS: Record<string, string[]> = {
	"file": ["links to", "in folder", "has tag", "has property", "does not link to", "is not in folder", "does not have tag", "does not have property"],
	"file.name": ["is", "is not", "starts with", "ends with", "is empty", "contains", "contains any of", "contains all of", "does not start with", "does not end with", "is not empty", "does not contain", "does not contain any of", "does not contain all of"],
	"file.folder": ["is", "is not", "starts with", "ends with", "is empty", "contains", "contains any of", "contains all of", "does not start with", "does not end with", "is not empty", "does not contain", "does not contain any of", "does not contain all of"],
};

/**
 * Returns the operator list for a given field and type.
 * Field-specific overrides take priority, then type-based lookup.
 */
function getOperatorsForField(field: string, type: PropertyType): string[] {
	const fieldOps = FIELD_OPERATORS[field];
	if (fieldOps) return fieldOps;
	const opsKey = type === "datetime" ? "date" : (type === "unknown" ? "text" : type);
	return TYPE_OPERATORS[opsKey] ?? TEXT_OPERATORS;
}

interface PropertyDef {
	key: string;
	type: PropertyType;
}

interface ComboboxItem {
	label: string;
	value: string;
	icon?: string;
}

/**
 * Unified combobox modal for property and operator selection.
 */
class ComboboxSuggestModal extends FuzzySuggestModal<ComboboxItem> {
	private items: ComboboxItem[];
	private selectedValue: string;
	private onSelect: (val: string) => void;
	private anchorEl: HTMLElement | null = null;
	private clickOutsideHandler: ((evt: MouseEvent) => void) | null = null;

	constructor(
		app: App,
		items: ComboboxItem[],
		selectedValue: string,
		onSelect: (val: string) => void,
		anchorEl?: HTMLElement
	) {
		super(app);
		this.items = items;
		this.selectedValue = selectedValue;
		this.onSelect = onSelect;
		this.anchorEl = anchorEl || null;
	}

	getItems(): ComboboxItem[] {
		return this.items;
	}

	getItemText(item: ComboboxItem): string {
		return item.label;
	}

	onOpen() {
		void super.onOpen();

		// Style modal as combobox
		window.requestAnimationFrame(() => {
			const modalContainer = this.modalEl.closest(".modal-container");
			if (modalContainer) {
				modalContainer.addClass("ap-modal-container");
				modalContainer.removeClass("mod-dim");
				const modalBg = modalContainer.querySelector(".modal-bg");
				if (modalBg) {
					(modalBg as HTMLElement).addClass("ap-modal-bg-hidden");
				}
			}
		});

		this.modalEl.addClass("ap-suggestion-container", "ap-combobox");

		// Position relative to anchor element
		if (this.anchorEl) {
			const rect = this.anchorEl.getBoundingClientRect();
			this.modalEl.addClass("ap-combobox-positioned");
			// Use CSS custom properties for dynamic positioning (setProperty is acceptable for CSS variables)
			this.modalEl.style.setProperty("--ap-combobox-left", `${rect.left}px`);
			this.modalEl.style.setProperty("--ap-combobox-top", `${rect.bottom + 5}px`);
		}

		// Style input and container
		const promptEl = this.modalEl.querySelector(".prompt-input-container");
		if (promptEl) {
			promptEl.addClass("ap-search-input-container");
			// Render search icon via Obsidian API (avoids CSS mask-image)
			const searchIcon = createEl("div", { cls: "ap-search-icon" });
			setIcon(searchIcon, "search");
			promptEl.prepend(searchIcon);
			const input = promptEl.querySelector("input");
			if (input) {
				input.setAttribute("type", "search");
				input.setAttribute("placeholder", "Search...");

				// Show/hide clear button based on input text
				const updateClearButtonVisibility = () => {
					const clearButton = promptEl.querySelector(".search-input-clear-button") as HTMLElement;
					if (clearButton) {
						if (input.value.trim().length > 0) {
							clearButton.removeClass("ap-clear-button-hidden");
							clearButton.addClass("ap-clear-button-visible");
						} else {
							clearButton.removeClass("ap-clear-button-visible");
							clearButton.addClass("ap-clear-button-hidden");
						}
					}
				};

				// Initial state - use requestAnimationFrame to ensure DOM is ready
				window.requestAnimationFrame(() => {
					updateClearButtonVisibility();
				});

				// Update on input change
				input.addEventListener("input", updateClearButtonVisibility);

				// Tab: select highlighted and advance. Shift+Tab: close and focus previous combobox.
				input.addEventListener("keydown", (e) => {
					if (e.key !== "Tab") return;
					e.preventDefault();
					if (e.shiftKey) {
						this.close();
						const prev = this.anchorEl?.previousElementSibling as HTMLElement;
						if (prev) prev.focus();
					} else {
						const highlighted = this.modalEl.querySelector(".suggestion-item.is-selected") as HTMLElement;
						if (highlighted) highlighted.click();
						else this.close();
					}
				});
			}
		}

		const suggestionsEl = this.modalEl.querySelector(".suggestion-container");
		if (suggestionsEl) {
			suggestionsEl.addClass("ap-suggestion");
		}

		// Keep anchor focused
		if (this.anchorEl) {
			if (this.anchorEl.getAttribute("tabindex") === "-1") {
				this.anchorEl.setAttribute("tabindex", "0");
			}
			window.requestAnimationFrame(() => {
				this.anchorEl?.focus();
			});
		}

		// Click-outside handler
		this.clickOutsideHandler = (evt: MouseEvent) => {
			const target = evt.target as Node;
			const isOutsideModal = !this.modalEl.contains(target) && this.modalEl !== target;
			const isNotAnchor = this.anchorEl !== target && !this.anchorEl?.contains(target);
			if (isOutsideModal && isNotAnchor) {
				this.close();
			}
		};

		window.setTimeout(() => {
			activeDocument.addEventListener("mousedown", this.clickOutsideHandler!);
		}, 0);
	}

	renderSuggestion(match: FuzzyMatch<ComboboxItem>, el: HTMLElement): void {
		const item = match.item;
		el.addClass("ap-suggestion-item", "ap-mod-complex", "ap-mod-toggle");

		if (item.value === this.selectedValue) {
			const checkIcon = el.createDiv({ cls: "ap-suggestion-icon ap-mod-checked" });
			setIcon(checkIcon, "check");
		}

		if (item.icon) {
			const iconDiv = el.createDiv({ cls: "ap-suggestion-icon" });
			const flair = iconDiv.createSpan({ cls: "ap-suggestion-flair" });
			setIcon(flair, item.icon);
		}

		const content = el.createDiv({ cls: "ap-suggestion-content" });
		content.createDiv({ cls: "ap-suggestion-title", text: item.label });
	}

	onChooseItem(item: ComboboxItem): void {
		this.onSelect(item.value);
	}

	onClose() {
		if (this.clickOutsideHandler) {
			activeDocument.removeEventListener("mousedown", this.clickOutsideHandler);
			this.clickOutsideHandler = null;
		}

		// Remove focus class from button and filter expression
		if (this.anchorEl) {
			// Find the ap-filter-expression element that contains the anchor
			const expression = this.anchorEl.closest(".ap-filter-expression") as HTMLElement;
			removeFocusClasses(this.anchorEl, expression);
		}

		const modalContainer = this.modalEl.closest(".modal-container");
		if (modalContainer) {
			modalContainer.removeClass("ap-modal-container");
			modalContainer.addClass("mod-dim");
			const modalBg = modalContainer.querySelector(".modal-bg");
			if (modalBg) {
				(modalBg as HTMLElement).removeClass("ap-modal-bg-hidden");
			}
		}
		super.onClose();
	}
}

/**
 * Helper functions for UI component creation
 */
function createComboboxButton(
	container: HTMLElement,
	label: string,
	icon?: string
): HTMLElement {
	const button = container.createDiv({ cls: "ap-combobox-button", attr: { tabindex: "0" } });

	if (icon) {
		const iconEl = button.createDiv({ cls: "ap-combobox-button-icon" });
		setIcon(iconEl, icon);
	}

	const labelEl = button.createDiv({ cls: "ap-combobox-button-label" });
	labelEl.innerText = label;
	setIcon(button.createDiv({ cls: "ap-combobox-button-chevron" }), "chevrons-up-down");

	return button;
}

function createDeleteButton(
	container: HTMLElement,
	onClick: (e: MouseEvent) => void
): HTMLElement {
	const deleteBtn = container.createEl("button", {
		cls: "clickable-icon",
		attr: { "aria-label": "Remove filter" },
	});
	setIcon(deleteBtn, "trash-2");
	deleteBtn.onclick = (e) => {
		e.stopPropagation();
		onClick(e);
	};
	return deleteBtn;
}

function addFocusClasses(button: HTMLElement, parent: HTMLElement): void {
	button.addClass("ap-has-focus");
	parent.addClass("ap-has-focus");
}

function removeFocusClasses(button: HTMLElement | null, parent: HTMLElement | null): void {
	button?.removeClass("ap-has-focus");
	parent?.removeClass("ap-has-focus");
}

function createFilterValueInput(
	container: HTMLElement,
	type: PropertyType,
	value: string | undefined,
	onChange: (val: string) => void,
	operator?: string,
	app?: App,
	field?: string
): HTMLInputElement | HTMLElement {
	const safeValue = value || "";
	const needsMultiSelect = operator === "contains any of" || operator === "does not contain any of"
		|| operator === "contains all of" || operator === "does not contain all of"
		|| operator === "is exactly" || operator === "is not exactly"
		|| operator === "has tag" || operator === "does not have tag";
	if (needsMultiSelect) {
		// Multi-select container for operators that accept multiple values
		const multiSelectContainer = container.createDiv({ cls: "ap-multi-select-container", attr: { tabindex: "-1" } });

		// Parse existing values (comma-separated)
		const values: string[] = safeValue ? safeValue.split(",").map((v) => v.trim()).filter((v) => v.length > 0) : [];

		// Create contenteditable input
		const input = multiSelectContainer.createDiv({
			cls: "ap-multi-select-input",
			attr: {
				contenteditable: "true",
				tabindex: "0",
				"data-placeholder": "Empty",
			},
		});

		// Focus input when clicking on container (but not on child elements)
		multiSelectContainer.addEventListener("click", (e: MouseEvent) => {
			// Only focus if clicking directly on the container, not on pills or input
			if (e.target === multiSelectContainer) {
				e.preventDefault();
				input.focus();
			}
		});

		// Helper to update placeholder based on pill count
		const updatePlaceholder = (): void => {
			input.setAttribute("data-placeholder", values.length === 0 ? "Empty" : "");
		};

		// Helper to get all pills in order
		const getPills = (): HTMLElement[] => {
			return Array.from(multiSelectContainer.querySelectorAll(".multi-select-pill"));
		};

		// Helper to get the index of a pill
		const getPillIndex = (pill: HTMLElement): number => {
			return getPills().indexOf(pill);
		};

		// Helper to focus a pill by index
		const focusPill = (index: number): void => {
			getPills()[index]?.focus();
		};

		// Helper to focus the last pill
		const focusLastPill = (): void => {
			const pills = getPills();
			pills[pills.length - 1]?.focus();
		};

		// Helper to focus the input
		const focusInput = (): void => {
			input.focus();
		};

		// Helper to clear input and ensure placeholder shows
		const clearInput = () => {
			input.textContent = "";
			// Remove any <br> tags that might prevent :empty from working
			const br = input.querySelector("br");
			if (br) br.remove();
		};

		// Mutable reference for inline suggest (assigned later)
		let inlineSuggest: FileSuggest | FolderSuggest | TagSuggest | PropertySuggest | FrontmatterValueSuggest | null = null;

		// Handle keyboard navigation in input
		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const text = input.textContent?.trim() || "";
				if (text.length > 0) {
					values.push(text);
					onChange(values.join(","));
					updatePills();
					clearInput();
					updatePlaceholder();
					// Focus back to input after creating pill
					window.requestAnimationFrame(() => focusInput());
				}
			} else if (e.key === "Tab" && !e.shiftKey) {
				// Accept the highlighted inline suggestion if open
				if (inlineSuggest?.selectHighlighted()) {
					e.preventDefault();
				}
			} else if (e.key === "Backspace" || e.key === "ArrowLeft") {
				// If input is empty, focus the last pill
				const text = input.textContent?.trim() || "";
				if (text.length === 0) {
					e.preventDefault();
					focusLastPill();
				}
			}
		});

		// Handle paste to split by comma/newline
		input.addEventListener("paste", (e: ClipboardEvent) => {
			e.preventDefault();
			const pastedText = e.clipboardData?.getData("text") || "";
			const newValues = pastedText.split(/[,\n]/).map((v) => v.trim()).filter((v) => v.length > 0);
			if (newValues.length > 0) {
				values.push(...newValues);
				onChange(values.join(","));
				updatePills();
				clearInput();
				updatePlaceholder();
			}
		});

		// Helper to set up pill keyboard navigation
		const setupPillNavigation = (pill: HTMLElement): void => {
			pill.addEventListener("keydown", (e: KeyboardEvent) => {
				const currentIndex = getPillIndex(pill);
				if (e.key === "Backspace" || e.key === "Delete") {
					e.preventDefault();
					e.stopPropagation();
					if (currentIndex > -1 && currentIndex < values.length) {
						values.splice(currentIndex, 1);
						onChange(values.join(","));
						updatePills();
						// Focus previous pill or input
						if (values.length > 0) {
							const newIndex = Math.max(0, currentIndex - 1);
							window.requestAnimationFrame(() => focusPill(newIndex));
						} else {
							window.requestAnimationFrame(() => focusInput());
						}
					}
				} else if ((e.key === "Tab" && !e.shiftKey) || e.key === "ArrowRight") {
					e.preventDefault();
					const pills = getPills();
					// Focus next pill or input if last pill
					if (currentIndex < pills.length - 1) {
						focusPill(currentIndex + 1);
					} else {
						focusInput();
					}
				} else if (e.key === "ArrowLeft") {
					e.preventDefault();
					// Focus previous pill; wrap to input if first pill
					if (currentIndex > 0) {
						focusPill(currentIndex - 1);
					} else {
						focusInput();
					}
				} else if (e.key === "Tab" && e.shiftKey) {
					// Focus previous pill, or let default Tab bubble out to previous combobox
					if (currentIndex > 0) {
						e.preventDefault();
						focusPill(currentIndex - 1);
					}
					// else: don't preventDefault — let browser move focus to previous element
				}
			});
		};

		// Function to update pills (defined here to access navigation functions)
		const updatePills = (): void => {
			// Remove all pills (but keep the input)
			const pills = multiSelectContainer.querySelectorAll(".multi-select-pill");
			pills.forEach((pill) => pill.remove());

			// Recreate pills with navigation handlers
			values.forEach((val, index) => {
				createPill(multiSelectContainer, val, () => {
					if (index > -1 && index < values.length) {
						values.splice(index, 1);
						onChange(values.join(","));
						updatePills();
						updatePlaceholder();
						// After deletion, focus the previous pill or input
						if (values.length > 0) {
							const newIndex = Math.min(index, values.length - 1);
							window.requestAnimationFrame(() => focusPill(newIndex));
						} else {
							window.requestAnimationFrame(() => focusInput());
						}
					}
				}, (pill: HTMLElement) => {
					setupPillNavigation(pill);
				}, app);
			});

			// Ensure input is last
			multiSelectContainer.appendChild(input);
			// Update placeholder after pills are updated
			updatePlaceholder();
		};

		// Initial render of pills
		updatePills();
		// Set initial placeholder
		updatePlaceholder();

		// Accept text on blur (with delay to avoid conflict with suggest selection)
		let blurTimeout: number | null = null;
		const acceptInputText = (): void => {
			const text = input.textContent?.trim() || "";
			if (text.length > 0) {
				values.push(text);
				onChange(values.join(","));
				updatePills();
				clearInput();
				updatePlaceholder();
			}
		};
		input.addEventListener("blur", () => {
			blurTimeout = window.setTimeout(() => {
				blurTimeout = null;
				acceptInputText();
			}, 150);
		});

		// Attach inline suggestions for multi-select inputs
		if (app) {
			const addPillFromSuggest = (text: string): void => {
				// Cancel pending blur acceptance — suggest takes priority
				if (blurTimeout) {
					window.clearTimeout(blurTimeout);
					blurTimeout = null;
				}
				if (text.trim().length > 0 && !values.includes(text.trim())) {
					values.push(text.trim());
					onChange(values.join(","));
					updatePills();
					clearInput();
					updatePlaceholder();
					window.requestAnimationFrame(() => focusInput());
				}
			};

			const suggest = createSuggestForInput(app, input, operator, field);
			if (suggest) {
				suggest.setExcludeValues(values);
				suggest.onSelectCb(addPillFromSuggest);
				inlineSuggest = suggest;
			}
		}

		return multiSelectContainer;
	} else if (type === "date" || type === "datetime") {
		const input = container.createEl("input", {
			type: type === "datetime" ? "datetime-local" : "date",
			value: safeValue,
			attr: {
				max: type === "datetime" ? "9999-12-31T23:59" : "9999-12-31",
			},
		});
		input.oninput = () => onChange(input.value);
		return input;
	} else if (type === "number") {
		const input = container.createEl("input", { type: "number", value: safeValue });
		input.oninput = () => onChange(input.value);
		return input;
	} else {
		// For wikilink values, render like Obsidian bases: metadata-link with pencil flair
		if (isWikilink(safeValue) && app) {
			const input = container.createEl("input", { type: "text", value: safeValue });
			input.addClass("metadata-input", "metadata-input-text");
			input.placeholder = "Value...";
			input.oninput = () => onChange(input.value);

			const linkTarget = extractWikilinkTarget(safeValue);
			const resolved = app.metadataCache.getFirstLinkpathDest(linkTarget, "");

			const metadataLink = container.createDiv({ cls: "metadata-link" });
			const linkEl = metadataLink.createDiv({
				cls: "metadata-link-inner internal-link",
				text: extractWikilinkDisplay(safeValue),
				attr: { "data-href": linkTarget, draggable: "true" },
			});
			if (!resolved) linkEl.addClass("is-unresolved");
			const flair = metadataLink.createDiv({ cls: "metadata-link-flair" });
			setIcon(flair, "pencil");

			const enterEditMode = () => {
				metadataLink.addClass("ap-hidden");
				input.removeClass("ap-hidden");
				input.focus();
				input.select();
			};

			// Click link text → open file in background
			linkEl.addEventListener("click", (e) => {
				e.stopPropagation();
				openWikilinkFile(app, extractWikilinkTarget(input.value));
			});

			// Click pencil or anywhere else on metadata-link → enter edit mode
			flair.addEventListener("click", (e) => {
				e.stopPropagation();
				enterEditMode();
			});
			metadataLink.addEventListener("click", enterEditMode);

			// When input loses focus, restore link display if value is still a wikilink
			input.addEventListener("blur", () => {
				if (isWikilink(input.value)) {
					metadataLink.removeClass("ap-hidden");
					input.addClass("ap-hidden");
					const newTarget = extractWikilinkTarget(input.value);
					const newResolved = app.metadataCache.getFirstLinkpathDest(newTarget, "");
					linkEl.setText(extractWikilinkDisplay(input.value));
					linkEl.setAttribute("data-href", newTarget);
					if (newResolved) linkEl.removeClass("is-unresolved");
					else linkEl.addClass("is-unresolved");
				}
			});

			// Start with link visible, input hidden
			input.addClass("ap-hidden");

			// Attach inline suggestions
			const suggest = createSuggestForInput(app, input, operator, field);
			if (suggest) {
				suggest.onSelectCb((text: string) => {
					input.value = text;
					input.dispatchEvent(new Event("input"));
					onChange(text);
				});
			}

			return container;
		}

		const input = container.createEl("input", { type: "text", value: safeValue });
		input.addClass("metadata-input", "metadata-input-text");
		input.placeholder = "Value...";
		input.oninput = () => onChange(input.value);

		// Attach inline suggestions for single-value text inputs
		if (app) {
			const suggest = createSuggestForInput(app, input, operator, field);
			if (suggest) {
				suggest.onSelectCb((text: string) => {
					input.value = text;
					input.dispatchEvent(new Event("input"));
					onChange(text);
				});
			}
		}

		return input;
	}
}

/**
 * Creates the appropriate suggest provider based on the field.
 * Returns the suggest instance or null if no suggest is applicable.
 */
function createSuggestForInput(
	app: App,
	inputEl: HTMLInputElement | HTMLDivElement,
	operator?: string,
	field?: string
): FileSuggest | FolderSuggest | TagSuggest | PropertySuggest | FrontmatterValueSuggest | null {
	if (!field) return null;

	// Field-based suggest mapping
	if (field === "file links") return new FileSuggest(app, inputEl);
	if (field === "file.folder") return new FolderSuggest(app, inputEl);
	if (field === "file tags") return new TagSuggest(app, inputEl);
	if (field === "aliases") return new FrontmatterValueSuggest(app, inputEl, "aliases");

	// Operator-based suggests for "file" field rules
	if (field === "file") {
		if (operator === "links to" || operator === "does not link to") return new FileSuggest(app, inputEl);
		if (operator === "in folder" || operator === "is not in folder") return new FolderSuggest(app, inputEl);
		if (operator === "has tag" || operator === "does not have tag") return new TagSuggest(app, inputEl);
		if (operator === "has property" || operator === "does not have property") return new PropertySuggest(app, inputEl);
		return null;
	}

	// For frontmatter property values — suggest existing values
	// Skip built-in file.* properties (file.name, file.path, etc.)
	if (!field.startsWith("file.")) {
		return new FrontmatterValueSuggest(app, inputEl, field);
	}

	return null;
}

function createPill(container: HTMLElement, value: string, onRemove: () => void, onCreated?: (pill: HTMLElement) => void, app?: App): void {
	const pill = container.createDiv({ cls: "multi-select-pill", attr: { tabindex: "0" } });

	// Detect wikilinks and render with internal-link styling
	if (isWikilink(value) && app) {
		pill.addClass("ap-pill-wikilink");
		const linkTarget = extractWikilinkTarget(value);
		const resolved = app.metadataCache.getFirstLinkpathDest(linkTarget, "");
		const contentEl = pill.createDiv({ cls: "multi-select-pill-content internal-link" });
		if (!resolved) contentEl.addClass("is-unresolved");
		contentEl.setAttribute("data-href", linkTarget);
		contentEl.setText(extractWikilinkDisplay(value));

		// Click on content opens the file
		contentEl.addEventListener("click", (e) => {
			e.stopPropagation();
			e.preventDefault();
			openWikilinkFile(app, linkTarget);
		});
	} else {
		pill.createDiv({ cls: "multi-select-pill-content", text: value });
	}

	const removeButton = pill.createDiv({ cls: "multi-select-pill-remove-button" });
	setIcon(removeButton, "x");
	removeButton.onclick = (e) => {
		e.stopPropagation();
		onRemove();
	};
	if (onCreated) {
		onCreated(pill);
	}
}

function setupComboboxButtonHandlers(
	button: HTMLElement,
	parent: HTMLElement,
	onOpen: () => void
): void {
	button.onclick = (e) => {
		e.preventDefault();
		e.stopPropagation();
		onOpen();
	};

	button.onkeydown = (e) => {
		if (e.key === " ") {
			e.preventDefault();
			e.stopPropagation();
			onOpen();
		}
	};
}

const PROPERTY_SCAN_TTL_MS = 30_000;
let propertyScanCache: {
	app: App;
	at: number;
	properties: PropertyDef[];
} | null = null;

export class FilterBuilder {
	private app: App;
	root: FilterGroup;
	private onSave: () => void;
	private onRefresh: () => void;
	private availableProperties: PropertyDef[];
	/** Pending auto-open action after refresh. Consumed by renderFilterRow. */
	private pendingAutoOpen: { filter: Filter; action: "operator" | "value" } | null = null;

	constructor(app: App, root: FilterGroup, onSave: () => void, onRefresh: () => void) {
		this.app = app;
		this.root = root;
		this.onSave = onSave;
		this.onRefresh = onRefresh;
		this.availableProperties = this.scanVaultProperties();
	}

	/**
	 * Gets the display label for a property key
	 */
	private getPropertyLabel(key: string): string {
		const labelMap: Record<string, string> = {
			"file.name": "file name",
			"file.path": "file path",
			"file.folder": "folder",
			"file.size": "file size",
			"file.ctime": "created time",
			"file.mtime": "modified time",
			"file links": "file links",
		};
		return labelMap[key] || key;
	}

	/**
	 * Gets the icon for a property
	 */
	private getPropertyIcon(key: string, type: PropertyType): string {
		if (key === "file links") return "link";
		if (key === "file tags") return "tags";
		if (key === "aliases") return "forward";
		if (key === "file.ctime" || key === "file.mtime") return "clock";
		return TYPE_ICONS[type] || "pilcrow";
	}

	/**
	 * Gets the Obsidian-assigned type for a property key from the internal
	 * metadataTypeManager registry. Returns null if not available.
	 */
	private getObsidianPropertyType(key: string): PropertyType | null {
		// Accessing undocumented Obsidian internal API
		const typeManager = (this.app as {
			metadataTypeManager?: { getAssignedType?(key: string): string | undefined };
		}).metadataTypeManager;
		if (!typeManager?.getAssignedType) return null;

		const obsidianType = typeManager.getAssignedType(key);
		if (!obsidianType) return null;

		// Map Obsidian's internal type names to our PropertyType
		const typeMap: Record<string, PropertyType> = {
			"text": "text",
			"number": "number",
			"date": "date",
			"datetime": "datetime",
			"checkbox": "checkbox",
			"tags": "list",
			"aliases": "list",
			"multitext": "list",
		};

		return typeMap[obsidianType] || null;
	}

	private scanVaultProperties(): PropertyDef[] {
		// The frontmatter sweep touches every markdown file's metadata cache; on
		// a 10k-note vault that is noticeable every time the filter UI opens, so
		// the result is shared briefly across builder instances.
		const cached = propertyScanCache;
		if (cached && Date.now() - cached.at < PROPERTY_SCAN_TTL_MS && cached.app === this.app) {
			return cached.properties;
		}
		const properties = this.scanVaultPropertiesUncached();
		propertyScanCache = { app: this.app, at: Date.now(), properties };
		return properties;
	}

	/**
	 * Scans the vault to find properties and their types.
	 * Uses Obsidian's metadataTypeManager when available, falls back to inference.
	 */
	private scanVaultPropertiesUncached(): PropertyDef[] {
		const propMap = new Map<string, PropertyType>();

		// Define built-in properties in the desired order
		const builtInProps: Array<[string, PropertyType]> = [
			["file", "file"],
			["file.name", "text"],
			["file.path", "text"],
			["file.folder", "text"],
			["file.ctime", "date"],
			["file.mtime", "date"],
			["file.size", "number"],
			["file links", "list"],
			["file tags", "list"],
			["aliases", "list"],
		];

		// Add built-in properties
		for (const [key, type] of builtInProps) {
			propMap.set(key, type);
		}

		// Scan frontmatter properties
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter) {
				for (const key of Object.keys(cache.frontmatter)) {
					if (key === "position" || key === "tags" || key === "aliases") continue;
					if (propMap.has(key) && propMap.get(key) !== "unknown") continue;

					// Prefer Obsidian's assigned type over inference
					const obsidianType = this.getObsidianPropertyType(key);
					if (obsidianType) {
						propMap.set(key, obsidianType);
					} else {
						propMap.set(key, inferType(cache.frontmatter[key]));
					}
				}
			}
		}

		// Separate built-in and custom properties
		const builtInKeys = new Set(builtInProps.map(([key]) => key));
		const builtIn: PropertyDef[] = [];
		const custom: PropertyDef[] = [];

		for (const [key, type] of propMap.entries()) {
			const def = { key, type };
			if (builtInKeys.has(key)) {
				builtIn.push(def);
			} else {
				custom.push(def);
			}
		}

		// Sort built-in by the defined order, custom alphabetically
		builtIn.sort((a, b) => {
			const aIndex = builtInProps.findIndex(([key]) => key === a.key);
			const bIndex = builtInProps.findIndex(([key]) => key === b.key);
			return aIndex - bIndex;
		});
		custom.sort((a, b) => a.key.localeCompare(b.key));

		return [...builtIn, ...custom];
	}

	private getPropertyType(key: string): PropertyType {
		return this.availableProperties.find((p) => p.key === key)?.type ?? "text";
	}

	render(container: HTMLElement): void {
		this.renderGroup(container, this.root, true);
	}

	private renderGroup(container: HTMLElement, group: FilterGroup, isRoot = false): void {
		const groupDiv = container.createDiv({ cls: "filter-group" });
		const header = groupDiv.createDiv({ cls: "filter-group-header" });

		const labelMap: Record<string, string> = {
			"AND": "All the following are true",
			"OR": "Any of the following are true",
			"NOR": "None of the following are true",
		};

		const valueMap: Record<string, string> = {
			"AND": "and",
			"OR": "or",
			"NOR": "not",
		};
		const reverseValueMap: Record<string, FilterConjunction> = {
			"and": "AND",
			"or": "OR",
			"not": "NOR",
		};

		const select = header.createEl("select", {
			cls: "conjunction dropdown",
			attr: { value: valueMap[group.operator] || "and" },
		});

		select.createEl("option", { attr: { value: "and" }, text: labelMap["AND"] });
		select.createEl("option", { attr: { value: "or" }, text: labelMap["OR"] });
		select.createEl("option", { attr: { value: "not" }, text: labelMap["NOR"] });

		select.value = valueMap[group.operator] || "and";

		select.onchange = () => {
			group.operator = reverseValueMap[select.value] ?? "AND";
			this.onSave();
			this.onRefresh();
		};

		const statementsContainer = groupDiv.createDiv({ cls: "filter-group-statements" });

		// If conditions is empty, show a default empty rule
		if (group.conditions.length === 0) {
			const rowWrapper = statementsContainer.createDiv({ cls: "filter-row" });
			const conjLabel = rowWrapper.createSpan({ cls: "conjunction" });
			conjLabel.innerText = "Where";

			// Create a temporary placeholder filter
			const placeholderFilter: Filter = { type: "filter", field: "file", operator: "links to", value: "" };
			this.renderFilterRow(rowWrapper, placeholderFilter, group, -1, true);
		} else {
			group.conditions.forEach((condition, index) => {
				const rowWrapper = statementsContainer.createDiv({ cls: "filter-row" });
				const conjLabel = rowWrapper.createSpan({ cls: "conjunction" });
				if (index === 0) {
					conjLabel.innerText = "Where";
				} else {
					conjLabel.innerText = (group.operator === "OR" || group.operator === "NOR") ? "or" : "and";
				}

				if (condition.type === "group") {
					rowWrapper.addClass("mod-group");
					this.renderGroup(rowWrapper, condition);

					const h = rowWrapper.querySelector(".filter-group-header");
					if (h) {
						const headerActionsDiv = h.createDiv({ cls: "filter-group-header-actions" });
						createDeleteButton(headerActionsDiv, () => {
							group.conditions.splice(index, 1);
							this.onSave();
							this.onRefresh();
						});
					}
				} else {
					this.renderFilterRow(rowWrapper, condition, group, index);
				}
			});
		}

		const actionsDiv = groupDiv.createDiv({ cls: "filter-group-actions" });
		this.createSimpleBtn(actionsDiv, "plus", "Add filter", () => {
			group.conditions.push({ type: "filter", field: "file", operator: "links to", value: "" });
			this.onSave();
			this.onRefresh();
		});
		this.createSimpleBtn(actionsDiv, "plus", "Add filter group", () => {
			group.conditions.push({ type: "group", operator: "AND", conditions: [] });
			this.onSave();
			this.onRefresh();
		});
	}

	private renderFilterRow(row: HTMLElement, filter: Filter, parentGroup: FilterGroup, index: number, isPlaceholder = false): void {
		const statement = row.createDiv({ cls: "ap-filter-statement" });
		const expression = statement.createDiv({ cls: "ap-filter-expression metadata-property" });

		const currentType = this.getPropertyType(filter.field);

		// Track if this placeholder has been added to the conditions array
		let placeholderAdded = false;

		// The condition this row currently edits: the original filter, or — once a
		// placeholder row commits — the condition appended to the parent group.
		const activeFilter = (): Filter | null => {
			if (!isPlaceholder) return filter;
			if (!placeholderAdded) return null;
			const last = parentGroup.conditions[parentGroup.conditions.length - 1];
			return last && last.type === "filter" ? last : null;
		};

		const propertyBtn = createComboboxButton(
			expression,
			this.getPropertyLabel(filter.field),
			this.getPropertyIcon(filter.field, currentType)
		);

		const openPropertyModal = () => {
			addFocusClasses(propertyBtn, expression);
			this.openCombobox(
				this.availableProperties.map((p) => ({
					label: this.getPropertyLabel(p.key),
					value: p.key,
					icon: this.getPropertyIcon(p.key, p.type),
				})),
				filter.field,
				(newVal) => {
					const newType = this.getPropertyType(newVal);
					const newOperator = getOperatorsForField(newVal, newType)[0] as FilterOperator;

					// If this is a placeholder, add it to the conditions array
					if (isPlaceholder && !placeholderAdded) {
						parentGroup.conditions.push({
							type: "filter",
							field: newVal,
							operator: newOperator,
							value: "",
						});
						placeholderAdded = true;
					} else {
						const target = activeFilter();
						if (target) {
							target.field = newVal;
							target.operator = newOperator;
							target.value = "";
						}
					}

					// Auto-advance: open operator modal after refresh
					const targetFilter = activeFilter();
					if (targetFilter) {
						this.pendingAutoOpen = { filter: targetFilter, action: "operator" };
					}

					this.onSave();
					this.onRefresh();
				},
				propertyBtn
			);
		};

		setupComboboxButtonHandlers(propertyBtn, statement, openPropertyModal);

		const validOps = getOperatorsForField(filter.field, currentType) as FilterOperator[];

		const operatorBtn = createComboboxButton(expression, filter.operator);

		const openOperatorModal = () => {
			addFocusClasses(operatorBtn, expression);
			this.openCombobox(
				validOps.map((op) => ({ label: op, value: op })),
				filter.operator,
				(newVal) => {
					const operator = newVal as FilterOperator;
					// If this is a placeholder, add it to the conditions array first
					if (isPlaceholder && !placeholderAdded) {
						parentGroup.conditions.push({ ...filter, operator });
						placeholderAdded = true;
					} else {
						const target = activeFilter();
						if (target) target.operator = operator;
					}

					// Auto-advance: focus value input after refresh (if operator takes a value)
					if (!["is empty", "is not empty"].includes(operator)) {
						const targetFilter = activeFilter();
						if (targetFilter) {
							this.pendingAutoOpen = { filter: targetFilter, action: "value" };
						}
					}

					this.onSave();
					this.onRefresh();
				},
				operatorBtn
			);
		};

		setupComboboxButtonHandlers(operatorBtn, statement, openOperatorModal);

		// Auto-advance: open operator modal if pending
		if (this.pendingAutoOpen?.filter === filter && this.pendingAutoOpen.action === "operator") {
			this.pendingAutoOpen = null;
			// Add focus class immediately to prevent flicker between combobox transitions
			addFocusClasses(operatorBtn, expression);
			window.setTimeout(() => openOperatorModal(), 50);
		}

		const handleDelete = () => {
			if (isPlaceholder) {
				// For placeholder, just refresh to show the default again
				this.onRefresh();
			} else {
				parentGroup.conditions.splice(index, 1);
				this.onSave();
				this.onRefresh();
			}
		};

		if (!["is empty", "is not empty"].includes(filter.operator)) {
			const rhs = expression.createDiv({ cls: "ap-filter-rhs-container metadata-property-value" });

			createFilterValueInput(rhs, currentType, filter.value, (val) => {
				// If this is a placeholder, add it to the conditions array first
				if (isPlaceholder && !placeholderAdded) {
					parentGroup.conditions.push({ ...filter, value: val });
					placeholderAdded = true;
				} else {
					const target = activeFilter();
					if (target) target.value = val;
				}

				this.onSave();
			}, filter.operator, this.app, filter.field);

			// Auto-advance: focus value input if pending
			if (this.pendingAutoOpen?.filter === filter && this.pendingAutoOpen.action === "value") {
				this.pendingAutoOpen = null;
				window.setTimeout(() => {
					const focusTarget = rhs.querySelector("input, .ap-multi-select-input") as HTMLElement;
					if (focusTarget) focusTarget.focus();
				}, 50);
			}
		}

		const actions = expression.createDiv({ cls: "ap-filter-row-actions" });
		createDeleteButton(actions, handleDelete);
	}

	private openCombobox(
		items: ComboboxItem[],
		selectedValue: string,
		onSelect: (val: string) => void,
		anchorEl?: HTMLElement
	): void {
		new ComboboxSuggestModal(this.app, items, selectedValue, onSelect, anchorEl).open();
	}

	private createSimpleBtn(container: HTMLElement, icon: string, text: string, onClick: () => void): void {
		const btn = container.createDiv({ cls: "ap-text-icon-button", attr: { tabindex: "0" } });
		setIcon(btn.createSpan({ cls: "ap-text-button-icon" }), icon);
		btn.createSpan({ cls: "ap-text-button-label", text });
		btn.onclick = (e) => {
			e.stopPropagation();
			onClick();
		};
	}
}

function inferType(val: unknown): PropertyType {
	if (val === null || val === undefined) return "unknown";
	if (Array.isArray(val)) return "list";
	if (typeof val === "number") return "number";
	if (typeof val === "boolean") return "checkbox";
	if (typeof val === "string") {
		if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return "date";
		if (/^\d{4}-\d{2}-\d{2}T/.test(val)) return "datetime";
	}
	return "text";
}
