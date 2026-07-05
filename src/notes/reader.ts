import { App, CachedMetadata, requestUrl, TFile } from "obsidian";
import {
	FilterGroup,
	NoteHeading,
	NoteIndexEntry,
	NoteIndexMedia,
	NoteMediaKind,
	NoteMediaReference,
	NoteStructure,
	PromptAttachment,
	TopicNote,
} from "../types";
import { checkRules } from "../filters/matcher";
import {
	cleanNoteText,
	computeFenceMask,
	extractSections,
	parseMarkdownImageReferences,
	parseInternalEmbedReference,
	parseSkillValue,
} from "./normalize";
import { pdfAttachmentSizeError } from "./attachment-budget";
import { buildRemotePromptAttachment, RemoteMediaFetchResult } from "./remote-media";
import { frontmatterDateMs, NoteDatePropertySettings } from "./frontmatter-dates";
import { frontmatterRecord, sanitizeFrontmatter } from "./frontmatter";
import {
	PromptAttachmentOptions,
	shouldAttachPromptMedia,
} from "./attachment-policy";
import { noteDisplayAliases, noteDisplayTitle } from "./titles";
import { LocalMediaLink, mergeLocalMediaLink } from "./media-links";

const DEFAULT_SKILL = 50;
const HISTORY_HEADING = "## Practice history";
const MAX_INLINE_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_INLINE_MEDIA_COUNT = 8;
const MAX_SVG_TEXT_CHARS = 24_000;

function isPdfFile(f: TFile): boolean {
	return f.extension === "pdf";
}

export function getTopicFiles(app: App, folder: string, filterRules?: FilterGroup): TFile[] {
	const allFiles = app.vault.getFiles().filter((f) => {
		if (f.extension !== "md" && f.extension !== "pdf") return false;
		if (folder && !(f.path.startsWith(folder + "/") || f.path === folder)) return false;
		if (filterRules && filterRules.conditions.length > 0) {
			if (isPdfFile(f)) {
				return checkRules(app, filterRules, f, undefined);
			}
			const cache = app.metadataCache.getFileCache(f);
			if (!checkRules(app, filterRules, f, cache?.frontmatter ?? undefined)) return false;
		}
		return true;
	});
	return allFiles;
}

export function fileToTopicNote(
	app: App,
	f: TFile,
	pdfSkills: Record<string, number>,
	dateProperties?: NoteDatePropertySettings
): TopicNote {
	const pdf = isPdfFile(f);
	const cache = pdf ? null : app.metadataCache.getFileCache(f);
	const frontmatter = frontmatterRecord(cache);
	const timestamps = noteTimestamps(f, frontmatter, dateProperties);
	const title = pdf ? f.basename : noteDisplayTitle(frontmatter, f.basename);
	const aliases = pdf ? [] : noteDisplayAliases(frontmatter, title);
	let skill: number;
	if (pdf) {
		const stored = pdfSkills[f.path];
		skill = parseSkillValue(stored, DEFAULT_SKILL);
	} else {
		skill = getSkillFromCache(app, f);
	}
	return {
		path: f.path,
		title,
		...(aliases.length > 0 ? { aliases } : {}),
		skill,
		isPdf: pdf,
		createdAt: timestamps.createdAt,
		updatedAt: timestamps.updatedAt,
	};
}

export function getTopicNotes(
	app: App,
	folder: string,
	pdfSkills: Record<string, number>,
	filterRules?: FilterGroup,
	dateProperties?: NoteDatePropertySettings
): TopicNote[] {
	return getTopicFiles(app, folder, filterRules).map((f) =>
		fileToTopicNote(app, f, pdfSkills, dateProperties)
	);
}

export function buildNoteIndexEntry(
	app: App,
	file: TFile,
	pdfSkills: Record<string, number>,
	indexedAt = Date.now(),
	dateProperties?: NoteDatePropertySettings
): NoteIndexEntry {
	const cache = app.metadataCache.getFileCache(file);
	const isPdf = isPdfFile(file);
	const media = isPdf ? [] : collectCachedMediaReferences(app, file, cache);
	const skill = isPdf ? getPdfSkill(file, pdfSkills) : getSkillFromCache(app, file);
	const frontmatter = isPdf ? undefined : frontmatterRecord(cache);
	const timestamps = noteTimestamps(file, frontmatter, dateProperties);
	const title = isPdf ? file.basename : noteDisplayTitle(frontmatter, file.basename);
	const aliases = isPdf ? [] : noteDisplayAliases(frontmatter, title);

	return {
		path: file.path,
		title,
		...(aliases.length > 0 ? { aliases } : {}),
		extension: file.extension,
		isPdf,
		frontmatter: isPdf
			? {}
			: sanitizeFrontmatter(frontmatterRecord(cache)),
		tags: isPdf ? [] : collectTags(cache),
		links: isPdf ? [] : collectLinks(cache),
		headings: isPdf ? [] : collectHeadings(cache, ""),
		media,
		estimatedWordCount: estimateWordCount(file),
		size: file.stat.size,
		skill,
		createdAt: timestamps.createdAt,
		updatedAt: timestamps.updatedAt,
		fileCreatedAt: file.stat.ctime,
		fileUpdatedAt: file.stat.mtime,
		indexedAt,
	};
}

export function getTopicNotesWithFilters(
	app: App,
	filterRules: FilterGroup,
	pdfSkills: Record<string, number>,
	dateProperties?: NoteDatePropertySettings
): TopicNote[] {
	const files = app.vault.getFiles().filter((f) => {
		if (f.extension !== "md" && f.extension !== "pdf") return false;
		if (filterRules.conditions.length === 0) return true;
		if (isPdfFile(f)) {
			return checkRules(app, filterRules, f, undefined);
		}
		const cache = app.metadataCache.getFileCache(f);
		return checkRules(app, filterRules, f, cache?.frontmatter ?? undefined);
	});

	return files.map((f) => fileToTopicNote(app, f, pdfSkills, dateProperties));
}

function getSkillFromCache(app: App, file: TFile): number {
	const cache = app.metadataCache.getFileCache(file);
	const frontmatter = frontmatterRecord(cache);
	return parseSkillValue(frontmatter?.["skill"], DEFAULT_SKILL);
}

function getPdfSkill(file: TFile, pdfSkills: Record<string, number>): number {
	return parseSkillValue(pdfSkills[file.path], DEFAULT_SKILL);
}

function noteTimestamps(
	file: TFile,
	frontmatter: Record<string, unknown> | undefined,
	dateProperties: NoteDatePropertySettings | undefined
): { createdAt: number; updatedAt: number } {
	const createdAt = dateProperties
		? frontmatterDateMs(frontmatter, dateProperties.createdDateProperties) ?? file.stat.ctime
		: file.stat.ctime;
	const updatedAt = dateProperties
		? frontmatterDateMs(frontmatter, dateProperties.updatedDateProperties) ?? file.stat.mtime
		: file.stat.mtime;
	return { createdAt, updatedAt };
}

export async function getNoteContent(app: App, path: string): Promise<string> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return "";
	return app.vault.read(file);
}

export async function getNoteStructure(
	app: App,
	path: string,
	dateProperties?: NoteDatePropertySettings
): Promise<NoteStructure | null> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile) || file.extension !== "md") return null;

	const raw = await app.vault.read(file);
	const cache = app.metadataCache.getFileCache(file);
	const frontmatter = frontmatterRecord(cache);
	const title = noteDisplayTitle(frontmatter, file.basename);
	const body = stripFrontmatter(raw);
	const withoutHistory = stripPracticeHistory(body);
	const cleanedText = cleanNoteText(withoutHistory);
	const sections = extractSections(cleanedText);
	const media = await collectMediaReferences(app, file, raw, cache);

	return {
		path: file.path,
		title,
		frontmatter: sanitizeFrontmatter(frontmatter),
		tags: collectTags(cache),
		links: collectLinks(cache),
		headings: collectHeadings(cache, cleanedText),
		sections,
		cleanedText,
		media,
		...noteTimestamps(file, frontmatter, dateProperties),
		contentHash: hashString(raw),
	};
}

export async function getPromptAttachments(
	app: App,
	structure: NoteStructure,
	noteTitle: string,
	options: PromptAttachmentOptions = {}
): Promise<PromptAttachment[]> {
	const attachments: PromptAttachment[] = [];
	let totalBytes = 0;

	for (const media of mediaAttachmentOrder(structure.media)) {
		if (attachments.length >= MAX_INLINE_MEDIA_COUNT) break;
		if (!shouldAttachPromptMedia(media, options)) continue;
		if (media.kind !== "image" && media.kind !== "pdf") continue;
		if (media.source === "remote") {
			const attachment = await buildRemotePromptAttachment(
				noteTitle,
				media,
				MAX_INLINE_MEDIA_BYTES - totalBytes,
				fetchRemoteMedia
			);
			if (attachment) {
				totalBytes += attachment.data.byteLength;
				attachments.push(attachment);
			}
			continue;
		}
		if (media.mimeType === "image/svg+xml") continue;
		if (media.size <= 0) continue;
		if (totalBytes + media.size > MAX_INLINE_MEDIA_BYTES) continue;

		const file = app.vault.getAbstractFileByPath(media.path);
		if (!(file instanceof TFile)) continue;
		const data = await app.vault.readBinary(file);
		totalBytes += data.byteLength;
		attachments.push({
			noteTitle,
			path: media.path,
			kind: media.kind,
			mimeType: media.mimeType,
			data,
		});
	}

	return attachments;
}

function mediaAttachmentOrder(media: NoteMediaReference[]): NoteMediaReference[] {
	const local = media.filter((item) => item.source !== "remote");
	const remote = media.filter((item) => item.source === "remote");
	return [...local, ...remote];
}

async function fetchRemoteMedia(url: string): Promise<RemoteMediaFetchResult> {
	const response = await requestUrl({
		url,
		method: "GET",
		throw: false,
	});
	return {
		status: response.status,
		headers: response.headers,
		arrayBuffer: response.arrayBuffer,
	};
}

export async function getPdfContent(app: App, path: string): Promise<ArrayBuffer> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return new ArrayBuffer(0);
	const sizeError = pdfAttachmentSizeError(file.path, file.stat.size);
	if (sizeError) throw new Error(sizeError);
	return app.vault.readBinary(file);
}

export async function getPastHistory(
	app: App,
	path: string
): Promise<string> {
	if (path.endsWith(".pdf")) return "";
	const content = await getNoteContent(app, path);
	const idx = content.indexOf(HISTORY_HEADING);
	if (idx === -1) return "";
	return content.slice(idx);
}

function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---")) return raw;
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return raw;
	const after = raw.indexOf("\n", end + 4);
	return after === -1 ? "" : raw.slice(after + 1);
}

function stripPracticeHistory(content: string): string {
	const idx = content.indexOf(HISTORY_HEADING);
	if (idx === -1) return content;
	return content.slice(0, idx).trimEnd();
}

function collectHeadings(cache: CachedMetadata | null, cleanedText: string): NoteHeading[] {
	const cached = cache?.headings?.map((heading) => ({
		heading: heading.heading,
		level: heading.level,
	})) ?? [];
	if (cached.length > 0) return cached;

	// Cold-start fallback (metadata cache not yet populated): parse headings from
	// text, skipping `#` lines inside fenced code blocks so code comments in CS
	// notes are not promoted to headings.
	const lines = cleanedText.split("\n");
	const fenceMask = computeFenceMask(lines);
	const headings: NoteHeading[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (fenceMask[i]) continue;
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i] ?? "");
		if (!match) continue;
		headings.push({
			heading: match[2] ?? "Untitled section",
			level: match[1]?.length ?? 1,
		});
	}
	return headings;
}

function collectTags(cache: CachedMetadata | null): string[] {
	const tags = new Set<string>();
	for (const tag of cache?.tags ?? []) {
		if (tag.tag) tags.add(tag.tag);
	}
	const frontmatter = frontmatterRecord(cache);
	const fmTags = frontmatter?.["tags"];
	if (Array.isArray(fmTags)) {
		for (const tag of fmTags) tags.add(`#${String(tag).replace(/^#/, "")}`);
	} else if (typeof fmTags === "string") {
		for (const tag of fmTags.split(/[,\s]+/)) {
			if (tag.trim()) tags.add(`#${tag.trim().replace(/^#/, "")}`);
		}
	}
	return [...tags].sort();
}

function collectLinks(cache: CachedMetadata | null): string[] {
	const links = new Set<string>();
	for (const link of cache?.links ?? []) links.add(link.link);
	for (const embed of cache?.embeds ?? []) links.add(embed.link);
	return [...links].sort();
}

function collectCachedMediaReferences(
	app: App,
	sourceFile: TFile,
	cache: CachedMetadata | null
): NoteIndexMedia[] {
	const links = new Map<string, NoteIndexMedia>();
	for (const embed of cache?.embeds ?? []) {
		const media = resolveMediaIndexReference(
			app,
			sourceFile,
			embed.link,
			embed.displayText ?? embed.link
		);
		if (media) links.set(media.path, media);
	}
	return [...links.values()];
}

function resolveMediaIndexReference(
	app: App,
	sourceFile: TFile,
	link: string,
	alt: string
): NoteIndexMedia | null {
	if (!link) return null;
	if (isRemoteMediaUrl(link)) {
		const url = normalizeRemoteMediaUrl(link);
		const mimeType = mimeTypeForUrl(url);
		return {
			path: url,
			kind: mediaKindForMime(mimeType),
			mimeType,
			size: 0,
			alt,
			source: "remote",
			url,
		};
	}
	const dest = app.metadataCache.getFirstLinkpathDest(link, sourceFile.path);
	if (!(dest instanceof TFile)) return null;
	const mimeType = mimeTypeForExtension(dest.extension);
	const kind = mediaKindForMime(mimeType);
	if (kind === "unknown") return null;
	return {
		path: dest.path,
		kind,
		mimeType,
		size: dest.stat.size,
		alt,
		source: "local",
	};
}

function estimateWordCount(file: TFile): number {
	if (file.extension === "pdf") return 0;
	return Math.max(0, Math.round(file.stat.size / 6));
}

async function collectMediaReferences(
	app: App,
	sourceFile: TFile,
	raw: string,
	cache: CachedMetadata | null
): Promise<NoteMediaReference[]> {
	const links = new Map<string, LocalMediaLink>();
	const remoteLinks = new Map<string, NoteMediaReference>();

	for (const embed of cache?.embeds ?? []) {
		addResolvedMediaLink(app, sourceFile, links, embed.link, embed.displayText ?? embed.link);
	}

	const internalEmbedRe = /!\[\[([^\]]+)\]\]/g;
	let internalMatch: RegExpExecArray | null;
	while ((internalMatch = internalEmbedRe.exec(raw)) !== null) {
		const parsed = parseInternalEmbedReference(internalMatch[1] ?? "");
		addResolvedMediaLink(
			app,
			sourceFile,
			links,
			parsed.link,
			parsed.alt
		);
	}

	for (const markdownImage of parseMarkdownImageReferences(raw)) {
		if (markdownImage.isRemote) {
			const url = normalizeRemoteMediaUrl(markdownImage.link);
			const mimeType = mimeTypeForUrl(url);
			if (mediaKindForMime(mimeType) === "unknown") continue;
			remoteLinks.set(url, {
				path: url,
				alt: markdownImage.alt,
				caption: markdownImage.caption,
				kind: mediaKindForMime(mimeType),
				mimeType,
				size: 0,
				source: "remote",
				url,
			});
		} else {
			addResolvedMediaLink(
				app,
				sourceFile,
				links,
				markdownImage.link,
				markdownImage.alt,
				markdownImage.caption
			);
		}
	}

	const media: NoteMediaReference[] = [...remoteLinks.values()];
	for (const { path, alt, caption } of links.values()) {
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;
		const mimeType = mimeTypeForExtension(file.extension);
		const kind = mediaKindForMime(mimeType);
		if (kind === "unknown") continue;
		const ref: NoteMediaReference = {
			path: file.path,
			alt,
			kind,
			mimeType,
			size: file.stat.size,
			source: "local",
		};
		if (caption) ref.caption = caption;
		if (kind === "svg" && file.stat.size <= MAX_SVG_TEXT_CHARS) {
			ref.svgText = await app.vault.read(file);
		}
		media.push(ref);
	}
	return media;
}

function addResolvedMediaLink(
	app: App,
	sourceFile: TFile,
	links: Map<string, LocalMediaLink>,
	link: string,
	alt: string,
	caption = ""
): void {
	if (!link || isRemoteMediaUrl(link)) return;
	const dest = app.metadataCache.getFirstLinkpathDest(link, sourceFile.path);
	if (!(dest instanceof TFile)) return;
	const mimeType = mimeTypeForExtension(dest.extension);
	if (mediaKindForMime(mimeType) === "unknown") return;
	mergeLocalMediaLink(links, {
		path: dest.path,
		alt,
		...(caption.trim() ? { caption: caption.trim() } : {}),
	});
}

function isRemoteMediaUrl(link: string): boolean {
	return /^(https?:)?\/\//i.test(link);
}

function normalizeRemoteMediaUrl(link: string): string {
	if (link.startsWith("//")) return `https:${link}`;
	return link;
}

function mimeTypeForExtension(extension: string): string {
	switch (extension.toLowerCase()) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "svg":
			return "image/svg+xml";
		case "pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}

function mimeTypeForUrl(url: string): string {
	const cleanUrl = url.split(/[?#]/)[0] ?? url;
	const match = /\.([A-Za-z0-9]+)$/.exec(cleanUrl);
	if (!match) return "image/*";
	return mimeTypeForExtension(match[1] ?? "");
}

function mediaKindForMime(mimeType: string): NoteMediaKind {
	if (mimeType === "application/pdf") return "pdf";
	if (mimeType === "image/svg+xml") return "svg";
	if (mimeType.startsWith("image/")) return "image";
	return "unknown";
}

function hashString(input: string): string {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
