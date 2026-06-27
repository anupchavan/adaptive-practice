import { App, TFile, FrontMatterCache } from "obsidian";
import { FilterGroup, Filter } from "../types";

export function checkRules(app: App, group: FilterGroup, file: TFile, frontmatter?: FrontMatterCache): boolean {
	if (!group || !group.conditions || group.conditions.length === 0) return true;

	const results = group.conditions.map(c =>
		c.type === "group" ? checkRules(app, c, file, frontmatter) : evaluateFilter(app, c, file, frontmatter)
	);

	if (group.operator === "AND") return results.every(r => r);
	if (group.operator === "OR") return results.some(r => r);
	if (group.operator === "NOR") return results.every(r => !r);
	return true;
}

function evaluateFilter(app: App, filter: Filter, file: TFile, frontmatter?: FrontMatterCache): boolean {
	if (filter.field === "file") {
		const fv = filter.value || "";
		switch (filter.operator) {
			case "links to":
			case "does not link to": {
				const target = app.metadataCache.getFirstLinkpathDest(fv, file.path);
				if (!target) return filter.operator === "does not link to";
				const cache = app.metadataCache.getFileCache(file);
				const linkPaths = (cache?.links || []).map(l => app.metadataCache.getFirstLinkpathDest(l.link, file.path)?.path).filter(Boolean) as string[];
				if (frontmatter) {
					const fm = frontmatter as Record<string, unknown>;
					for (const key of Object.keys(fm)) {
						for (const lt of extractLinks(fm[key])) {
							const rp = app.metadataCache.getFirstLinkpathDest(lt, file.path);
							if (rp?.path) linkPaths.push(rp.path);
						}
					}
				}
				const has = linkPaths.includes(target.path);
				return filter.operator === "links to" ? has : !has;
			}
			case "in folder":
			case "is not in folder": {
				const tf = fv.trim().replace(/^\/+|\/+$/g, "");
				if (!tf) return filter.operator === "is not in folder";
				const ff = (file.parent?.path || "").replace(/^\/+|\/+$/g, "");
				const inF = ff === tf || ff.startsWith(tf + "/");
				return filter.operator === "in folder" ? inF : !inF;
			}
			case "has tag":
			case "does not have tag": {
				const tags = fv.trim().split(",").map(t => t.trim()).filter(t => t.length > 0);
				if (tags.length === 0) return filter.operator === "does not have tag";
				const fileTags = getFileTags(app, file, frontmatter);
				const has = tags.some(ft => fileTags.some(t => t === ft || t.startsWith(ft + "/") || ft.startsWith(t + "/")));
				return filter.operator === "has tag" ? has : !has;
			}
			case "has property":
			case "does not have property": {
				const pn = fv.trim();
				if (!pn) return filter.operator === "does not have property";
				const has = frontmatter && pn in frontmatter;
				return filter.operator === "has property" ? !!has : !has;
			}
			default: return false;
		}
	}

	let targetValue: unknown = null;
	if (filter.field.startsWith("file.")) {
		if (filter.field === "file.name") targetValue = file.name;
		else if (filter.field === "file.path") targetValue = file.path;
		else if (filter.field === "file.folder") targetValue = file.parent?.path || "";
		else if (filter.field === "file.size") targetValue = file.stat.size;
		else if (filter.field === "file.ctime") targetValue = file.stat.ctime;
		else if (filter.field === "file.mtime") targetValue = file.stat.mtime;
		} else if (filter.field === "file tags") {
			targetValue = getFileTags(app, file, frontmatter);
		} else if (filter.field === "aliases") {
			const fm = (frontmatter as Record<string, unknown> | undefined)?.["aliases"];
			targetValue = Array.isArray(fm) ? fm.map(stringValue) : typeof fm === "string" ? [fm] : [];
		} else if (frontmatter) {
			const fm = frontmatter as Record<string, unknown>;
			targetValue = fm[filter.field] ?? null;
	}

	if (targetValue === undefined || targetValue === null) targetValue = "";

	const dateOps = ["on", "not on", "before", "on or before", "after", "on or after", "is empty", "is not empty"];
	if ((filter.field === "file.ctime" || filter.field === "file.mtime") && dateOps.includes(filter.operator) && typeof targetValue === "number") {
		if (filter.operator === "is empty") return !targetValue;
		if (filter.operator === "is not empty") return !!targetValue;
		const fds = (filter.value || "").toString().split("T")[0]!;
		if (!fds) return false;
		const td = new Date(new Date(targetValue).toISOString().split("T")[0]!);
		const fd = new Date(fds);
		td.setHours(0, 0, 0, 0); fd.setHours(0, 0, 0, 0);
		switch (filter.operator) {
			case "on": return td.getTime() === fd.getTime();
			case "not on": return td.getTime() !== fd.getTime();
			case "before": return td.getTime() < fd.getTime();
			case "on or before": return td.getTime() <= fd.getTime();
			case "after": return td.getTime() > fd.getTime();
			case "on or after": return td.getTime() >= fd.getTime();
			default: return false;
		}
	}

	const filterValue = stringValue(filter.value || "");

	if (Array.isArray(targetValue)) {
		const arr = targetValue as unknown[];
		switch (filter.operator) {
			case "is empty": return arr.length === 0;
			case "is not empty": return arr.length > 0;
			case "is": case "is not": { const m = arr.some(v => stringValue(v) === filterValue); return filter.operator === "is" ? m : !m; }
			case "contains": case "does not contain": { const m = arr.some(v => stringValue(v).includes(filterValue)); return filter.operator === "contains" ? m : !m; }
			case "contains any of": case "does not contain any of": {
				const fvs = (filter.value || "").split(",").map(v => v.trim()).filter(v => v.length > 0);
				if (fvs.length === 0) return filter.operator === "does not contain any of";
				const m = fvs.some(fv => arr.some(v => stringValue(v).includes(fv)));
				return filter.operator === "contains any of" ? m : !m;
			}
			case "contains all of": case "does not contain all of": {
				const fvs = (filter.value || "").split(",").map(v => v.trim()).filter(v => v.length > 0);
				if (fvs.length === 0) return filter.operator === "does not contain all of";
				const m = fvs.every(fv => arr.some(v => stringValue(v).includes(fv)));
				return filter.operator === "contains all of" ? m : !m;
			}
			default: return false;
		}
	} else {
		const sv = stringValue(targetValue);
		switch (filter.operator) {
			case "is empty": return !sv;
			case "is not empty": return !!sv;
			case "is": return sv === filterValue;
			case "is not": return sv !== filterValue;
			case "contains": return sv.includes(filterValue);
			case "does not contain": return !sv.includes(filterValue);
			case "starts with": return sv.startsWith(filterValue);
			case "ends with": return sv.endsWith(filterValue);
			case "contains any of": case "does not contain any of": {
				const fvs = (filter.value || "").split(",").map(v => v.trim()).filter(v => v.length > 0);
				if (fvs.length === 0) return filter.operator === "does not contain any of";
				const m = fvs.some(fv => sv.includes(fv));
				return filter.operator === "contains any of" ? m : !m;
			}
			case "contains all of": case "does not contain all of": {
				const fvs = (filter.value || "").split(",").map(v => v.trim()).filter(v => v.length > 0);
				if (fvs.length === 0) return filter.operator === "does not contain all of";
				const m = fvs.every(fv => sv.includes(fv));
				return filter.operator === "contains all of" ? m : !m;
			}
			default: return false;
		}
	}
}

function getFileTags(app: App, file: TFile, frontmatter?: FrontMatterCache): string[] {
	const cache = app.metadataCache.getFileCache(file);
	const body = (cache?.tags || []).map(t => t.tag.replace(/^#+/, ""));
	const fmTags = (frontmatter as Record<string, unknown> | undefined)?.["tags"];
	const fm: string[] = [];
	if (Array.isArray(fmTags)) fm.push(...fmTags.map(t => stringValue(t).replace(/^#+/, "")));
	else if (typeof fmTags === "string") fm.push(fmTags.replace(/^#+/, ""));
	return [...body, ...fm];
}

function extractLinks(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.flatMap(extractLinks);
	const s = stringValue(value);
	const re = /\[\[([^\]]+)\]\]/g;
	const out: string[] = [];
	let m;
	while ((m = re.exec(s)) !== null) out.push(m[1]!);
	return out;
}

function stringValue(value: unknown): string {
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return String(value);
	}
	return "";
}
