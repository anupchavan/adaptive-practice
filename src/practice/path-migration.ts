import { PracticeMemory } from "../types";

/**
 * Pure path-remapping helpers used by the vault rename/delete event handlers.
 *
 * All practice state except the `skill` frontmatter field is keyed by file path
 * in `data.json`. Without these, renaming or moving a note inside Obsidian
 * silently orphaned its entire learning history (skill, due date, streak input,
 * subtopic memory). A folder rename fires a single event for the folder, so the
 * remap matches by exact path or by `oldPath + "/"` prefix.
 */
export function remapPath(
	storedPath: string,
	oldPath: string,
	newPath: string,
	isFolder: boolean
): string | null {
	if (storedPath === oldPath) return newPath;
	if (!isFolder) return null;
	const prefix = `${oldPath}/`;
	if (storedPath.startsWith(prefix)) {
		return `${newPath}/${storedPath.slice(prefix.length)}`;
	}
	return null;
}

export function pathMatchesDeletion(
	storedPath: string,
	deletedPath: string,
	isFolder: boolean
): boolean {
	if (storedPath === deletedPath) return true;
	return isFolder && storedPath.startsWith(`${deletedPath}/`);
}

export function migratePracticeMemoryPaths(
	memory: PracticeMemory,
	oldPath: string,
	newPath: string,
	isFolder: boolean
): boolean {
	let changed = false;

	for (const [path, state] of Object.entries(memory.notes)) {
		const mapped = remapPath(path, oldPath, newPath, isFolder);
		if (mapped && mapped !== path) {
			delete memory.notes[path];
			memory.notes[mapped] = { ...state, path: mapped };
			changed = true;
		}
	}

	for (const [path, entry] of Object.entries(memory.index)) {
		const mapped = remapPath(path, oldPath, newPath, isFolder);
		if (mapped && mapped !== path) {
			delete memory.index[path];
			memory.index[mapped] = { ...entry, path: mapped };
			changed = true;
		}
	}

	return changed;
}

export function migratePdfSkillPaths(
	pdfSkills: Record<string, number>,
	oldPath: string,
	newPath: string,
	isFolder: boolean
): boolean {
	let changed = false;
	for (const [path, skill] of Object.entries(pdfSkills)) {
		const mapped = remapPath(path, oldPath, newPath, isFolder);
		if (mapped && mapped !== path) {
			delete pdfSkills[path];
			pdfSkills[mapped] = skill;
			changed = true;
		}
	}
	return changed;
}

export function prunePracticeMemoryPaths(
	memory: PracticeMemory,
	deletedPath: string,
	isFolder: boolean
): boolean {
	let changed = false;
	for (const path of Object.keys(memory.notes)) {
		if (pathMatchesDeletion(path, deletedPath, isFolder)) {
			delete memory.notes[path];
			changed = true;
		}
	}
	for (const path of Object.keys(memory.index)) {
		if (pathMatchesDeletion(path, deletedPath, isFolder)) {
			delete memory.index[path];
			changed = true;
		}
	}
	return changed;
}

export function prunePdfSkillPaths(
	pdfSkills: Record<string, number>,
	deletedPath: string,
	isFolder: boolean
): boolean {
	let changed = false;
	for (const path of Object.keys(pdfSkills)) {
		if (pathMatchesDeletion(path, deletedPath, isFolder)) {
			delete pdfSkills[path];
			changed = true;
		}
	}
	return changed;
}
