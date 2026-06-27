import { App } from "obsidian";
import { FilterGroup, NoteIndexEntry, TopicNote } from "../types";
import { buildNoteIndexEntry, fileToTopicNote, getTopicFiles } from "../notes/reader";
import { DEFAULT_SCAN_BATCH_SIZE, shouldYieldScanBatch } from "./scan-batches";
import { NoteDatePropertySettings } from "../notes/frontmatter-dates";
import { isIndexEntryCurrent } from "./index-freshness";

export interface VaultIndexResult {
	topics: TopicNote[];
	index: Record<string, NoteIndexEntry>;
	stats: VaultIndexStats;
}

export interface VaultIndexStats {
	total: number;
	indexed: number;
	reused: number;
	removed: number;
	pdfs: number;
	media: number;
	yielded: number;
}

export async function scanVaultSkeleton(
	app: App,
	folder: string,
	pdfSkills: Record<string, number>,
	filterRules: FilterGroup,
	previousIndex: Record<string, NoteIndexEntry>,
	dateProperties?: NoteDatePropertySettings,
	now = Date.now(),
	batchSize = DEFAULT_SCAN_BATCH_SIZE
): Promise<VaultIndexResult> {
	const files = getTopicFiles(app, folder, filterRules);
	const topics: TopicNote[] = [];
	const nextIndex: Record<string, NoteIndexEntry> = {};
	let indexed = 0;
	let reused = 0;
	let pdfs = 0;
	let media = 0;
	let yielded = 0;

	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		const topic = fileToTopicNote(app, file, pdfSkills, dateProperties);
		topics.push(topic);
		if (topic.isPdf) pdfs++;

		const previous = previousIndex[file.path];
		const canReuse = previous && isIndexEntryCurrent(previous, topic, {
			size: file.stat.size,
			createdAt: file.stat.ctime,
			updatedAt: file.stat.mtime,
		});
		const entry = canReuse
			? {
				...previous,
				title: topic.title,
				skill: topic.skill,
				createdAt: topic.createdAt ?? previous.createdAt,
				updatedAt: topic.updatedAt ?? previous.updatedAt,
				fileCreatedAt: file.stat.ctime,
				fileUpdatedAt: file.stat.mtime,
			}
			: buildNoteIndexEntry(app, file, pdfSkills, now, dateProperties);

		if (canReuse) reused++;
		else indexed++;
		media += entry.media.length;
		nextIndex[file.path] = entry;

		if (shouldYieldScanBatch(i + 1, files.length, batchSize)) {
			yielded++;
			await yieldToEventLoop();
		}
	}

	const removed = Object.keys(previousIndex).filter((path) => !nextIndex[path]).length;
	return {
		topics,
		index: nextIndex,
		stats: {
			total: files.length,
			indexed,
			reused,
			removed,
			pdfs,
			media,
			yielded,
		},
	};
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, 0);
	});
}
