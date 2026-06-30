import { App, normalizePath } from "obsidian";
import { NoteIndexEntry } from "../types";

const INDEX_FILE_NAME = "practice-index.json";

export interface StoredIndexFile {
	version: 1;
	index: Record<string, NoteIndexEntry>;
}

/**
 * The vault skeleton index is kept in its own file under the plugin folder
 * rather than inside `data.json`. It can be hundreds of KB to many MB on large
 * vaults, and bundling it with settings forced a full rewrite of everything on
 * every answer, draft autosave, and reminder tick. Splitting it keeps the hot
 * per-answer save path small and lets the index be written only when a scan,
 * rename, or delete actually changes it.
 */
export function indexStorePath(pluginDir: string): string {
	return normalizePath(`${pluginDir}/${INDEX_FILE_NAME}`);
}

export async function readIndexStore(
	app: App,
	pluginDir: string
): Promise<Record<string, NoteIndexEntry> | null> {
	const path = indexStorePath(pluginDir);
	try {
		if (!(await app.vault.adapter.exists(path))) return null;
		const raw = await app.vault.adapter.read(path);
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const index = (parsed as Partial<StoredIndexFile>).index;
		if (!index || typeof index !== "object") return null;
		return index;
	} catch {
		return null;
	}
}

export async function writeIndexStore(
	app: App,
	pluginDir: string,
	index: Record<string, NoteIndexEntry>
): Promise<void> {
	const payload: StoredIndexFile = { version: 1, index };
	await app.vault.adapter.write(indexStorePath(pluginDir), JSON.stringify(payload));
}
