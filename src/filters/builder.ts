import { App, FuzzySuggestModal, FuzzyMatch, setIcon } from "obsidian";
import { FilterGroup, Filter, FilterOperator, FilterConjunction } from "../types";

type PropertyType = "text" | "number" | "date" | "datetime" | "list" | "checkbox" | "file" | "unknown";

const TYPE_ICONS: Record<PropertyType, string> = {
	text: "text", number: "binary", date: "calendar", datetime: "clock",
	list: "list", checkbox: "check-square", file: "file", unknown: "text"
};

const OPERATORS: Record<string, string[]> = {
	text: ["contains", "does not contain", "is", "is not", "starts with", "ends with", "contains any of", "does not contain any of", "contains all of", "does not contain all of", "is empty", "is not empty"],
	list: ["contains", "does not contain", "contains any of", "does not contain any of", "contains all of", "does not contain all of", "is empty", "is not empty"],
	number: ["=", "≠", "<", "≤", ">", "≥", "is empty", "is not empty"],
	date: ["on", "not on", "before", "on or before", "after", "on or after", "is empty", "is not empty"],
	checkbox: ["is"],
	file: ["links to", "does not link to", "in folder", "is not in folder", "has tag", "does not have tag", "has property", "does not have property"]
};

interface PropertyDef { key: string; type: PropertyType; }
interface SuggestItem { label: string; value: string; icon?: string; }

class ComboboxSuggestModal extends FuzzySuggestModal<SuggestItem> {
	private items: SuggestItem[];
	private selectedValue: string;
	private onSelect: (val: string) => void;
	private anchorEl: HTMLElement | null;
	private clickOutsideHandler: ((evt: MouseEvent) => void) | null = null;

	constructor(app: App, items: SuggestItem[], selectedValue: string, onSelect: (val: string) => void, anchorEl?: HTMLElement) {
		super(app);
		this.items = items;
		this.selectedValue = selectedValue;
		this.onSelect = onSelect;
		this.anchorEl = anchorEl ?? null;
	}

	getItems(): SuggestItem[] { return this.items; }
	getItemText(item: SuggestItem): string { return item.label; }

	onOpen() {
		void super.onOpen();
		requestAnimationFrame(() => {
			const mc = this.modalEl.closest(".modal-container");
			if (mc) {
				mc.addClass("ap-modal-container");
				mc.removeClass("mod-dim");
				const bg = mc.querySelector(".modal-bg");
				if (bg) (bg as HTMLElement).addClass("ap-modal-bg-hidden");
			}
		});
		this.modalEl.addClass("ap-suggestion-container", "ap-combobox");
		if (this.anchorEl) {
			const rect = this.anchorEl.getBoundingClientRect();
			this.modalEl.addClass("ap-combobox-positioned");
			this.modalEl.style.setProperty("--ap-combobox-left", `${rect.left}px`);
			this.modalEl.style.setProperty("--ap-combobox-top", `${rect.bottom + 5}px`);
		}
		const promptEl = this.modalEl.querySelector(".prompt-input-container");
		if (promptEl) {
			promptEl.addClass("ap-search-input-container");
			const input = promptEl.querySelector("input");
			if (input) {
				input.setAttribute("type", "search");
				input.setAttribute("placeholder", "Search...");
				const updateClear = () => {
					const cb = promptEl.querySelector(".search-input-clear-button") as HTMLElement;
					if (cb) {
						if (input.value.trim().length > 0) { cb.removeClass("ap-clear-button-hidden"); cb.addClass("ap-clear-button-visible"); }
						else { cb.removeClass("ap-clear-button-visible"); cb.addClass("ap-clear-button-hidden"); }
					}
				};
				requestAnimationFrame(updateClear);
				input.addEventListener("input", updateClear);
			}
		}
		const sugEl = this.modalEl.querySelector(".suggestion-container");
		if (sugEl) sugEl.addClass("ap-suggestion");

		this.clickOutsideHandler = (evt: MouseEvent) => {
			const t = evt.target as Node;
			if (!this.modalEl.contains(t) && this.modalEl !== t && this.anchorEl !== t && !this.anchorEl?.contains(t)) this.close();
		};
		setTimeout(() => document.addEventListener("mousedown", this.clickOutsideHandler!), 0);
	}

	renderSuggestion(match: FuzzyMatch<SuggestItem>, el: HTMLElement): void {
		const item = match.item;
		el.addClass("ap-suggestion-item", "ap-mod-complex", "ap-mod-toggle");
		if (item.value === this.selectedValue) {
			const ci = el.createDiv({ cls: "ap-suggestion-icon ap-mod-checked" });
			setIcon(ci, "check");
		}
		if (item.icon) {
			const id = el.createDiv({ cls: "ap-suggestion-icon" });
			const fl = id.createSpan({ cls: "ap-suggestion-flair" });
			setIcon(fl, item.icon);
		}
		const c = el.createDiv({ cls: "ap-suggestion-content" });
		c.createDiv({ cls: "ap-suggestion-title", text: item.label });
	}

	onChooseItem(item: SuggestItem): void { this.onSelect(item.value); }

	onClose() {
		if (this.clickOutsideHandler) { document.removeEventListener("mousedown", this.clickOutsideHandler); this.clickOutsideHandler = null; }
		if (this.anchorEl) {
			const expr = this.anchorEl.closest(".ap-filter-expression") as HTMLElement;
			removeFocusClasses(this.anchorEl, expr);
		}
		const mc = this.modalEl.closest(".modal-container");
		if (mc) { mc.removeClass("ap-modal-container"); mc.addClass("mod-dim"); const bg = mc.querySelector(".modal-bg"); if (bg) (bg as HTMLElement).removeClass("ap-modal-bg-hidden"); }
		super.onClose();
	}
}

function createComboboxButton(container: HTMLElement, label: string, icon?: string): HTMLElement {
	const btn = container.createDiv({ cls: "ap-combobox-button", attr: { tabindex: "0" } });
	if (icon) { const ie = btn.createDiv({ cls: "ap-combobox-button-icon" }); setIcon(ie, icon); }
	btn.createDiv({ cls: "ap-combobox-button-label" }).innerText = label;
	setIcon(btn.createDiv({ cls: "ap-combobox-button-chevron" }), "chevrons-up-down");
	return btn;
}

function createDeleteButton(container: HTMLElement, onClick: (e: MouseEvent) => void): HTMLElement {
	const btn = container.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Remove filter" } });
	setIcon(btn, "trash-2");
	btn.onclick = (e) => { e.stopPropagation(); onClick(e); };
	return btn;
}

function addFocusClasses(button: HTMLElement, parent: HTMLElement): void { button.addClass("ap-has-focus"); parent.addClass("ap-has-focus"); }
function removeFocusClasses(button: HTMLElement | null, parent: HTMLElement | null): void { button?.removeClass("ap-has-focus"); parent?.removeClass("ap-has-focus"); }

function setupComboboxButtonHandlers(button: HTMLElement, parent: HTMLElement, onOpen: () => void): void {
	button.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onOpen(); };
	button.onkeydown = (e) => { if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); e.stopPropagation(); onOpen(); } };
}

function createFilterValueInput(
	container: HTMLElement, type: PropertyType, value: string | undefined,
	onChange: (val: string) => void, operator?: string
): HTMLInputElement | HTMLElement {
	const safeValue = value || "";
	const needsMultiSelect = operator === "contains any of" || operator === "does not contain any of"
		|| operator === "contains all of" || operator === "does not contain all of"
		|| operator === "has tag" || operator === "does not have tag";

	if (needsMultiSelect) {
		const msc = container.createDiv({ cls: "ap-multi-select-container", attr: { tabindex: "-1" } });
		const values: string[] = safeValue ? safeValue.split(",").map(v => v.trim()).filter(v => v.length > 0) : [];
		const input = msc.createDiv({ cls: "ap-multi-select-input", attr: { contenteditable: "true", tabindex: "0", "data-placeholder": "Empty" } });

		msc.addEventListener("click", (e: MouseEvent) => { if (e.target === msc) { e.preventDefault(); input.focus(); } });

		const updatePlaceholder = () => input.setAttribute("data-placeholder", values.length === 0 ? "Empty" : "");
		const getPills = (): HTMLElement[] => Array.from(msc.querySelectorAll(".multi-select-pill"));
		const focusPill = (i: number) => { const p = getPills(); if (i >= 0 && i < p.length) p[i]!.focus(); };
		const focusInput = () => input.focus();
		const clearInput = () => { input.textContent = ""; const br = input.querySelector("br"); if (br) br.remove(); };

		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") { e.preventDefault(); const t = input.textContent?.trim() || ""; if (t.length > 0) { values.push(t); onChange(values.join(",")); updatePills(); clearInput(); updatePlaceholder(); setTimeout(focusInput, 0); } }
			else if (e.key === "Backspace") { const t = input.textContent?.trim() || ""; if (t.length === 0) { e.preventDefault(); const p = getPills(); if (p.length > 0) p[p.length - 1]!.focus(); } }
		});
		input.addEventListener("paste", (e: ClipboardEvent) => {
			e.preventDefault(); const pt = e.clipboardData?.getData("text") || "";
			const nv = pt.split(/[,\n]/).map(v => v.trim()).filter(v => v.length > 0);
			if (nv.length > 0) { values.push(...nv); onChange(values.join(",")); updatePills(); clearInput(); updatePlaceholder(); }
		});

		const setupPillNav = (pill: HTMLElement) => {
			pill.addEventListener("keydown", (e: KeyboardEvent) => {
				const ci = getPills().indexOf(pill);
				if (e.key === "Backspace" || e.key === "Delete") {
					e.preventDefault(); e.stopPropagation();
					if (ci > -1 && ci < values.length) { values.splice(ci, 1); onChange(values.join(",")); updatePills(); if (values.length > 0) setTimeout(() => focusPill(Math.max(0, ci - 1)), 0); else setTimeout(focusInput, 0); }
				} else if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); const p = getPills(); if (ci < p.length - 1) focusPill(ci + 1); else focusInput(); }
				else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); if (ci > 0) focusPill(ci - 1); else focusInput(); }
			});
		};

		const updatePills = () => {
			msc.querySelectorAll(".multi-select-pill").forEach(p => p.remove());
			values.forEach((val, idx) => {
				const pill = msc.createDiv({ cls: "multi-select-pill", attr: { tabindex: "0" } });
				pill.createDiv({ cls: "multi-select-pill-content", text: val });
				const rb = pill.createDiv({ cls: "multi-select-pill-remove-button" });
				setIcon(rb, "x");
				rb.onclick = (e) => { e.stopPropagation(); values.splice(idx, 1); onChange(values.join(",")); updatePills(); updatePlaceholder(); if (values.length > 0) setTimeout(() => focusPill(Math.min(idx, values.length - 1)), 0); else setTimeout(focusInput, 0); };
				setupPillNav(pill);
			});
			msc.appendChild(input);
			updatePlaceholder();
		};
		updatePills();
		return msc;
	} else if (type === "date" || type === "datetime") {
		const inp = container.createEl("input", { type: type === "datetime" ? "datetime-local" : "date", value: safeValue, attr: { max: type === "datetime" ? "9999-12-31T23:59" : "9999-12-31" } });
		inp.oninput = () => onChange(inp.value);
		return inp;
	} else if (type === "number") {
		const inp = container.createEl("input", { type: "number", value: safeValue });
		inp.oninput = () => onChange(inp.value);
		return inp;
	} else {
		const inp = container.createEl("input", { type: "text", value: safeValue });
		inp.addClass("metadata-input", "metadata-input-text");
		inp.placeholder = "Value...";
		inp.oninput = () => onChange(inp.value);
		return inp;
	}
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

	constructor(app: App, root: FilterGroup, onSave: () => void, onRefresh: () => void) {
		this.app = app;
		this.root = root;
		this.onSave = onSave;
		this.onRefresh = onRefresh;
		this.availableProperties = this.scanVaultProperties();
	}

	private getPropertyLabel(key: string): string {
		const m: Record<string, string> = { "file.name": "file name", "file.path": "file path", "file.folder": "folder", "file.size": "file size", "file.ctime": "created time", "file.mtime": "modified time" };
		return m[key] || key;
	}

	private getPropertyIcon(key: string, type: PropertyType): string {
		if (key === "file tags") return "tags";
		if (key === "aliases") return "forward";
		if (key === "file.ctime" || key === "file.mtime") return "clock";
		return TYPE_ICONS[type] || "pilcrow";
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

	private scanVaultPropertiesUncached(): PropertyDef[] {
		const propMap = new Map<string, PropertyType>();
		const builtInProps: Array<[string, PropertyType]> = [
			["file", "file"], ["file.name", "text"], ["file.path", "text"], ["file.folder", "text"],
			["file.ctime", "date"], ["file.mtime", "date"], ["file.size", "number"],
			["file tags", "list"], ["aliases", "list"]
		];
		for (const [k, t] of builtInProps) propMap.set(k, t);

		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter) {
				for (const key of Object.keys(cache.frontmatter)) {
					if (key === "position" || key === "tags" || key === "aliases") continue;
					if (propMap.has(key) && propMap.get(key) !== "unknown") continue;
					propMap.set(key, inferType(cache.frontmatter[key]));
				}
			}
		}

		const builtInKeys = new Set(builtInProps.map(([k]) => k));
		const builtIn: PropertyDef[] = [];
		const custom: PropertyDef[] = [];
		for (const [k, t] of propMap.entries()) {
			if (builtInKeys.has(k)) builtIn.push({ key: k, type: t });
			else custom.push({ key: k, type: t });
		}
		builtIn.sort((a, b) => builtInProps.findIndex(([k]) => k === a.key) - builtInProps.findIndex(([k]) => k === b.key));
		custom.sort((a, b) => a.key.localeCompare(b.key));
		return [...builtIn, ...custom];
	}

	private getPropertyType(key: string): PropertyType {
		return this.availableProperties.find(p => p.key === key)?.type ?? "text";
	}

	render(container: HTMLElement): void { this.renderGroup(container, this.root, true); }

	private renderGroup(container: HTMLElement, group: FilterGroup, isRoot = false): void {
		const gd = container.createDiv({ cls: "filter-group" });
		const header = gd.createDiv({ cls: "filter-group-header" });

		const labelMap: Record<string, string> = { AND: "All the following are true", OR: "Any of the following are true", NOR: "None of the following are true" };
		const valueMap: Record<string, string> = { AND: "and", OR: "or", NOR: "not" };
		const reverseMap: Record<string, FilterConjunction> = { and: "AND", or: "OR", not: "NOR" };

		const select = header.createEl("select", { cls: "conjunction dropdown", attr: { value: valueMap[group.operator] || "and" } });
		select.createEl("option", { attr: { value: "and" }, text: labelMap["AND"] });
		select.createEl("option", { attr: { value: "or" }, text: labelMap["OR"] });
		select.createEl("option", { attr: { value: "not" }, text: labelMap["NOR"] });
		select.value = valueMap[group.operator] || "and";
		select.onchange = () => { group.operator = reverseMap[select.value]!; this.onSave(); this.onRefresh(); };

		const stmts = gd.createDiv({ cls: "filter-group-statements" });

		if (group.conditions.length === 0) {
			const rw = stmts.createDiv({ cls: "filter-row" });
			rw.createSpan({ cls: "conjunction" }).innerText = "Where";
			const placeholder: Filter = { type: "filter", field: "file", operator: "links to", value: "" };
			this.renderFilterRow(rw, placeholder, group, -1, true);
		} else {
			group.conditions.forEach((cond, idx) => {
				const rw = stmts.createDiv({ cls: "filter-row" });
				const conj = rw.createSpan({ cls: "conjunction" });
				conj.innerText = idx === 0 ? "Where" : (group.operator === "OR" || group.operator === "NOR") ? "or" : "and";

				if (cond.type === "group") {
					rw.addClass("mod-group");
					this.renderGroup(rw, cond);
					const h = rw.querySelector(".filter-group-header");
					if (h) {
						const ha = h.createDiv({ cls: "filter-group-header-actions" });
						createDeleteButton(ha, () => { group.conditions.splice(idx, 1); this.onSave(); this.onRefresh(); });
					}
				} else {
					this.renderFilterRow(rw, cond, group, idx);
				}
			});
		}

		const actions = gd.createDiv({ cls: "filter-group-actions" });
		this.createSimpleBtn(actions, "plus", "Add filter", () => { group.conditions.push({ type: "filter", field: "file", operator: "links to", value: "" }); this.onSave(); this.onRefresh(); });
		this.createSimpleBtn(actions, "plus", "Add filter group", () => { group.conditions.push({ type: "group", operator: "AND", conditions: [] }); this.onSave(); this.onRefresh(); });
	}

	private renderFilterRow(row: HTMLElement, filter: Filter, parentGroup: FilterGroup, index: number, isPlaceholder = false): void {
		const stmt = row.createDiv({ cls: "ap-filter-statement" });
		const expr = stmt.createDiv({ cls: "ap-filter-expression metadata-property" });
		const currentType = this.getPropertyType(filter.field);
		let placeholderAdded = false;

		const propBtn = createComboboxButton(expr, this.getPropertyLabel(filter.field), this.getPropertyIcon(filter.field, currentType));
		const openPropModal = () => {
			addFocusClasses(propBtn, expr);
			new ComboboxSuggestModal(this.app,
				this.availableProperties.map(p => ({ label: this.getPropertyLabel(p.key), value: p.key, icon: this.getPropertyIcon(p.key, p.type) })),
				filter.field,
				(nv) => {
					const nt = this.getPropertyType(nv);
					const vo = OPERATORS[nt === "datetime" ? "date" : nt] || OPERATORS["text"];
					const newOp = vo![0] as FilterOperator;
					if (isPlaceholder && !placeholderAdded) { parentGroup.conditions.push({ type: "filter", field: nv, operator: newOp, value: "" }); placeholderAdded = true; }
					else if (isPlaceholder && placeholderAdded) { const c = parentGroup.conditions[parentGroup.conditions.length - 1]; if (c?.type === "filter") { c.field = nv; c.operator = newOp; c.value = ""; } }
					else { filter.field = nv; filter.operator = newOp; filter.value = ""; }
					this.onSave(); this.onRefresh();
				}, propBtn
			).open();
		};
		setupComboboxButtonHandlers(propBtn, stmt, openPropModal);

		let opsKey: string = currentType;
		if (currentType === "datetime") opsKey = "date";
		if (currentType === "unknown") opsKey = "text";
		if (!OPERATORS[opsKey]) opsKey = "text";
		const validOps = OPERATORS[opsKey] as FilterOperator[];

		const opBtn = createComboboxButton(expr, filter.operator);
		const openOpModal = () => {
			addFocusClasses(opBtn, expr);
			new ComboboxSuggestModal(this.app,
				validOps.map(op => ({ label: op, value: op })),
				filter.operator,
				(nv) => {
					const op = nv as FilterOperator;
					if (isPlaceholder && !placeholderAdded) { parentGroup.conditions.push({ ...filter, operator: op }); placeholderAdded = true; }
					else if (isPlaceholder && placeholderAdded) { const c = parentGroup.conditions[parentGroup.conditions.length - 1]; if (c?.type === "filter") c.operator = op; }
					else filter.operator = op;
					this.onSave(); this.onRefresh();
				}, opBtn
			).open();
		};
		setupComboboxButtonHandlers(opBtn, stmt, openOpModal);

		const handleDelete = () => {
			if (isPlaceholder) this.onRefresh();
			else { parentGroup.conditions.splice(index, 1); this.onSave(); this.onRefresh(); }
		};

		if (!["is empty", "is not empty"].includes(filter.operator)) {
			const rhs = expr.createDiv({ cls: "ap-filter-rhs-container metadata-property-value" });
			createFilterValueInput(rhs, currentType, filter.value, (val) => {
				if (isPlaceholder && !placeholderAdded) { parentGroup.conditions.push({ ...filter, value: val }); placeholderAdded = true; }
				else if (isPlaceholder && placeholderAdded) { const c = parentGroup.conditions[parentGroup.conditions.length - 1]; if (c?.type === "filter") c.value = val; }
				else filter.value = val;
				this.onSave();
			}, filter.operator);
		}

		const acts = expr.createDiv({ cls: "ap-filter-row-actions" });
		createDeleteButton(acts, handleDelete);
	}

	private createSimpleBtn(container: HTMLElement, icon: string, text: string, onClick: () => void): void {
		const btn = container.createDiv({ cls: "ap-text-icon-button", attr: { tabindex: "0" } });
		setIcon(btn.createSpan({ cls: "ap-text-button-icon" }), icon);
		btn.createSpan({ cls: "ap-text-button-label", text });
		btn.onclick = (e) => { e.stopPropagation(); onClick(); };
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
