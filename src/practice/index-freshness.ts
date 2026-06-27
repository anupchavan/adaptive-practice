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
		entry.title === topic.title
	);
}
