/**
 * The portable .whetstone progress file at the vault root - the exact
 * format the Whetstone desktop apps and engine write (WSTN1 magic, XOR
 * obfuscation, {version, learner:{notes, revision}, app}). Skills live
 * here instead of in note frontmatter, so the plugin, the apps, and the
 * engine all share one progress store that travels with the vault.
 *
 * Reads are cached in-module because note scanning is synchronous;
 * call ensureVaultSkills before any batch that needs fresh values.
 */

import { App } from "obsidian";

const MAGIC = "WSTN1";
const KEY = "whetstone-progress-v1";
const FILE = ".whetstone";

export interface VaultNoteState {
	skill: number;
	observations?: number;
	last_practiced?: number;
	interval_days?: number;
}

interface VaultLearner {
	notes: Record<string, VaultNoteState>;
	revision: number;
}

interface VaultFile {
	version: number;
	learner: VaultLearner;
	app: unknown;
}

let cache: Record<string, VaultNoteState> = {};
let loadedFor: string | null = null;

function xor(body: Uint8Array): Uint8Array {
	const key = new TextEncoder().encode(KEY);
	const out = new Uint8Array(body.length);
	for (let i = 0; i < body.length; i++) {
		out[i] = (body[i] ?? 0) ^ (key[i % key.length] ?? 0);
	}
	return out;
}

function decode(raw: ArrayBuffer): VaultFile | null {
	const bytes = new Uint8Array(raw);
	const magic = new TextDecoder().decode(bytes.slice(0, MAGIC.length));
	if (magic !== MAGIC) return null;
	try {
		const plain = xor(bytes.slice(MAGIC.length));
		return JSON.parse(new TextDecoder().decode(plain)) as VaultFile;
	} catch {
		return null;
	}
}

function encode(vault: VaultFile): ArrayBuffer {
	const plain = new TextEncoder().encode(JSON.stringify(vault));
	const out = new Uint8Array(MAGIC.length + plain.length);
	out.set(new TextEncoder().encode(MAGIC), 0);
	out.set(xor(plain), MAGIC.length);
	return out.buffer;
}

async function readVault(app: App): Promise<VaultFile> {
	try {
		if (await app.vault.adapter.exists(FILE)) {
			const decoded = decode(await app.vault.adapter.readBinary(FILE));
			if (decoded?.learner?.notes) return decoded;
		}
	} catch {
		// unreadable or foreign file - start fresh, never crash practice
	}
	return { version: 1, learner: { notes: {}, revision: 0 }, app: null };
}

/** Refresh the sync skill cache from disk (cheap; call before scans). */
export async function ensureVaultSkills(app: App): Promise<void> {
	const vault = await readVault(app);
	cache = vault.learner.notes;
	loadedFor = app.vault.getName();
}

/** Sync lookup for note scanning; null when this note has no entry yet. */
export function vaultSkill(app: App, path: string): number | null {
	if (loadedFor !== app.vault.getName()) return null;
	const entry = cache[path];
	return typeof entry?.skill === "number" ? entry.skill : null;
}

/** Merge one note's new skill into the shared file (read-modify-write). */
export async function writeVaultSkill(
	app: App,
	path: string,
	skill: number
): Promise<void> {
	const vault = await readVault(app);
	const existing = vault.learner.notes[path];
	vault.learner.notes[path] = {
		...existing,
		skill,
		observations: (existing?.observations ?? 0) + 1,
		last_practiced: Date.now() / 1000,
	};
	vault.learner.revision = (vault.learner.revision ?? 0) + 1;
	await app.vault.adapter.writeBinary(FILE, encode(vault));
	cache = vault.learner.notes;
	loadedFor = app.vault.getName();
}
