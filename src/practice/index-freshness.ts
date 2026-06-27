import { NoteIndexEntry, TopicNote } from "../types";

export interface FileStatSignature {
	size: number;
	createdAt: number;
	updatedAt: number;
}

export function isIndexEntryCurrent(
	entry: NoteIndexEntry,
	topic: TopicNote,
	fileStat: FileStatSignature
): boolean {
	return (
		entry.fileUpdatedAt === fileStat.updatedAt &&
		entry.fileCreatedAt === fileStat.createdAt &&
		entry.size === fileStat.size &&
		entry.skill === topic.skill &&
		entry.title === topic.title &&
		sameAliases(entry.aliases, topic.aliases)
	);
}

function sameAliases(a: string[] | undefined, b: string[] | undefined): boolean {
	const left = normalizeAliases(a);
	const right = normalizeAliases(b);
	if (left.length !== right.length) return false;
	return left.every((alias, index) => alias === right[index]);
}

function normalizeAliases(input: string[] | undefined): string[] {
	return (input ?? [])
		.map((alias) => alias.toLowerCase().replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.sort();
}
