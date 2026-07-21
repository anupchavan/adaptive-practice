/**
 * Desktop bridge to the Whetstone native engine - the open-source Rust
 * pipeline behind the desktop apps. Whole-session generation delegates to
 * it: seeded authoring, machine verification, blind probes, clarity
 * gating, Elo calibration. The engine binary is resolved from an explicit
 * path, an installed app, or a one-time download from the public releases,
 * and every candidate must pass a health probe before it is trusted.
 */

import { App, Platform, requestUrl } from "obsidian";
import type {
	AdaptivePracticeSettings,
	Difficulty,
	LlmProvider,
	Question,
	SessionConfig,
} from "../types";

const ENGINE_RELEASE_BASE =
	"https://github.com/anupchavan/whetstone-releases/releases/latest/download";

interface EngineQuestion {
	id: string;
	type?: string;
	question_text: string;
	options?: string[];
	correct_answer: string;
	correct_answers?: string[];
	explanation: string;
	source_title?: string;
	difficulty?: string;
}

interface EngineProcess {
	stdin: { write(data: string): void };
	stdout: { on(event: "data", listener: (chunk: Uint8Array) => void): void };
	on(event: "error", listener: (error: Error) => void): void;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
	kill(): void;
}

/** The Node surface this bridge needs, reachable only on desktop. */
interface DesktopApis {
	spawn(command: string, args: string[], options: {
		env: Record<string, string | undefined>;
		stdio: [string, string, string];
	}): EngineProcess;
	probeStatus(command: string, args: string[], timeoutMs: number): number | null;
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: { recursive: boolean }): void;
	writeFileSync(path: string, data: Uint8Array): void;
	chmodSync(path: string, mode: number): void;
	rmSync(path: string, options: { force: boolean }): void;
	dirname(path: string): string;
	env: Record<string, string | undefined>;
}

let cachedApis: DesktopApis | null | undefined;

function desktopApis(): DesktopApis | null {
	if (Platform.isMobile) return null;
	if (cachedApis !== undefined) return cachedApis;
	// Electron's require is the only road to Node built-ins; it does not
	// exist on mobile, which the Platform guard above already excludes.
	const nodeRequire = (window as unknown as { require?: (module: string) => unknown }).require;
	if (!nodeRequire) {
		cachedApis = null;
		return cachedApis;
	}
	const fs = nodeRequire("fs") as {
		existsSync(path: string): boolean;
		mkdirSync(path: string, options: { recursive: boolean }): void;
		writeFileSync(path: string, data: Uint8Array): void;
		chmodSync(path: string, mode: number): void;
		rmSync(path: string, options: { force: boolean }): void;
	};
	const childProcess = nodeRequire("child_process") as {
		spawn: DesktopApis["spawn"];
		spawnSync(command: string, args: string[], options: { timeout: number }): {
			status: number | null;
		};
	};
	const path = nodeRequire("path") as { dirname(p: string): string };
	const proc = nodeRequire("process") as { env: Record<string, string | undefined> };
	cachedApis = {
		spawn: childProcess.spawn.bind(childProcess),
		probeStatus: (command, args, timeoutMs) => {
			try {
				return childProcess.spawnSync(command, args, { timeout: timeoutMs }).status;
			} catch {
				return null;
			}
		},
		existsSync: fs.existsSync.bind(fs),
		mkdirSync: fs.mkdirSync.bind(fs),
		writeFileSync: fs.writeFileSync.bind(fs),
		chmodSync: fs.chmodSync.bind(fs),
		rmSync: fs.rmSync.bind(fs),
		dirname: path.dirname.bind(path),
		env: proc.env,
	};
	return cachedApis;
}

function vaultBasePath(app: App): string | null {
	const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
	return adapter.getBasePath ? adapter.getBasePath() : null;
}

/** The per-platform engine asset name, or null when none is published. */
export function engineAssetName(): string | null {
	const apis = desktopApis();
	if (!apis) return null;
	const proc = window as unknown as { process?: { platform: string; arch: string } };
	const platform = proc.process?.platform;
	const arch = proc.process?.arch;
	switch (platform) {
		case "darwin":
			return arch === "arm64" ? "whetstone-engine-macos-arm64" : null;
		case "linux":
			return arch === "arm64"
				? "whetstone-engine-linux-arm64"
				: "whetstone-engine-linux-x64";
		case "win32":
			return arch === "arm64"
				? "whetstone-engine-windows-arm64.exe"
				: "whetstone-engine-windows-x64.exe";
		default:
			return null;
	}
}

function downloadedEnginePath(app: App): string | null {
	const base = vaultBasePath(app);
	const asset = engineAssetName();
	if (!base || !asset) return null;
	return `${base}/${app.vault.configDir}/plugins/adaptive-practice/bin/${asset}`;
}

/**
 * A candidate must actually run: a stale or broken install (for example a
 * sidecar that dies on launch) is skipped so resolution falls through to
 * the next candidate or a fresh download instead of hanging forever.
 */
function binaryResponds(apis: DesktopApis, binary: string): boolean {
	return apis.probeStatus(binary, ["--version"], 5000) === 0;
}

/** Resolve a working engine binary, or null when this device has none. */
export function engineBinaryPath(
	settings: AdaptivePracticeSettings,
	app?: App
): string | null {
	const apis = desktopApis();
	if (!apis) return null;
	const explicit = settings.nativeEnginePath.trim();
	const home = apis.env.HOME ?? "";
	const candidates = explicit.length > 0 ? [explicit] : [
		app ? downloadedEnginePath(app) ?? "" : "",
		"/Applications/Whetstone.app/Contents/MacOS/whetstone-sidecar",
		`${home}/Applications/Whetstone.app/Contents/MacOS/whetstone-sidecar`,
		`${home}/Projects/whetstone/target/release/whetstone`,
		`${apis.env.LOCALAPPDATA ?? ""}\\Whetstone\\whetstone-engine.exe`,
	];
	for (const candidate of candidates) {
		try {
			if (candidate && apis.existsSync(candidate) && binaryResponds(apis, candidate)) {
				return candidate;
			}
		} catch {
			// unreadable candidate - keep looking
		}
	}
	return null;
}

/**
 * The plugin works without the Whetstone app: when no working binary is
 * found, fetch the platform's engine from the public releases into the
 * plugin's own bin directory. One-time, a few megabytes, desktop only.
 */
export async function ensureEngine(
	app: App,
	settings: AdaptivePracticeSettings
): Promise<string | null> {
	const apis = desktopApis();
	if (!apis) return null;
	const existing = engineBinaryPath(settings, app);
	if (existing) return existing;
	const target = downloadedEnginePath(app);
	const asset = engineAssetName();
	if (!target || !asset) return null;
	const response = await requestUrl({ url: `${ENGINE_RELEASE_BASE}/${asset}` });
	if (response.status !== 200) return null;
	apis.mkdirSync(apis.dirname(target), { recursive: true });
	apis.writeFileSync(target, new Uint8Array(response.arrayBuffer));
	const proc = window as unknown as { process?: { platform: string } };
	if (proc.process?.platform !== "win32") apis.chmodSync(target, 0o755);
	if (!binaryResponds(apis, target)) {
		apis.rmSync(target, { force: true });
		return null;
	}
	return target;
}

export interface EngineSession {
	/** The early-ready opening batch (the engine streams the rest). */
	first: Question[];
	/** New questions accumulated since `asked`; [] once generation ends. */
	next(asked: Question[]): Promise<Question[]>;
	cancel(): void;
}

interface EngineResponse {
	status: string;
	question_set?: { questions: EngineQuestion[] };
	job?: { job_id: string; state: string; error?: string; message?: string } | null;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Start generation and return as soon as the engine's opening batch is
 * ready (it begins serving at three accepted questions); keep polling in
 * the background and hand later arrivals to the practice view on demand.
 */
export async function generateSessionWithEngine(
	app: App,
	apiKey: string,
	config: SessionConfig,
	provider: LlmProvider,
	settings: AdaptivePracticeSettings
): Promise<EngineSession> {
	const apis = desktopApis();
	const binary = await ensureEngine(app, settings);
	const base = vaultBasePath(app);
	if (!apis || !binary || !base) {
		throw new Error(
			"The native engine could not be found or downloaded. Set an explicit path in settings."
		);
	}
	const dataDir = `${base}/${app.vault.configDir}/plugins/adaptive-practice/engine-data`;
	const child = apis.spawn(binary, ["serve"], {
		env: { ...apis.env, WHETSTONE_DATA_DIR: dataDir },
		stdio: ["pipe", "pipe", "pipe"],
	});

	let nextId = 1;
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	const rejectAll = (reason: string): void => {
		for (const waiter of pending.values()) waiter.reject(new Error(reason));
		pending.clear();
	};
	child.on("error", (error) => rejectAll(`The engine could not start: ${error.message}`));
	child.on("exit", (code, signal) => {
		if (pending.size > 0) {
			rejectAll(
				`The engine stopped unexpectedly (${signal ?? code ?? "?"}). Try again; a fresh engine will be downloaded if needed.`
			);
		}
	});
	let buffer = "";
	const decoder = new TextDecoder();
	child.stdout.on("data", (chunk) => {
		buffer += decoder.decode(chunk, { stream: true });
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line.trim()) continue;
			try {
				const message = JSON.parse(line) as {
					id: number;
					ok?: boolean;
					data?: unknown;
					error?: string;
				};
				const waiter = pending.get(message.id);
				if (waiter) {
					pending.delete(message.id);
					if (message.ok === false) waiter.reject(new Error(message.error ?? "engine error"));
					else waiter.resolve(message.data);
				}
			} catch {
				// non-protocol stdout noise - ignore
			}
		}
	});

	const request = <T>(method: string, params: unknown): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});

	const seen = new Set<string>();
	const pool: Question[] = [];
	let done = false;
	let failure: Error | null = null;

	const absorb = (response: EngineResponse): void => {
		for (const q of response.question_set?.questions ?? []) {
			if (seen.has(q.id)) continue;
			seen.add(q.id);
			pool.push(toPluginQuestion(q, config));
		}
	};

	await request("set_config", {
		library_root: base,
		provider,
		quality_tier: settings.qualityTier || "scholar",
		ollama_model: settings.providerModels.ollama ?? undefined,
		cli_model: settings.providerModels["claude-code"] ?? undefined,
		codex_model: settings.providerModels.codex ?? undefined,
	});
	let response = await request<EngineResponse>("start_session", {
		note_paths: config.topics.map((topic) => topic.path),
		count: config.questionCount,
		api_key: apiKey,
	});
	const jobId = response.job?.job_id;
	// Wait for the opening batch (or a cached-ready pool, or a failure).
	while (response.status !== "ready") {
		if (response.job?.state === "failed") {
			child.kill();
			throw new Error(response.job.error ?? "The engine could not prepare questions.");
		}
		await sleep(3000);
		response = await request<EngineResponse>("preparation_status", { job_id: jobId });
	}
	absorb(response);
	if (!response.job) done = true;

	// Background poller: keep absorbing until the job settles.
	const poll = async (): Promise<void> => {
		while (!done) {
			await sleep(3000);
			if (done) break;
			try {
				const fresh = await request<EngineResponse>("preparation_status", { job_id: jobId });
				absorb(fresh);
				if (fresh.job?.state === "failed") {
					failure = new Error(fresh.job.error ?? "Generation stopped early.");
					done = true;
				} else if (!fresh.job) {
					done = true;
				}
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error));
				done = true;
			}
		}
		child.kill();
	};
	if (!done) void poll();
	else child.kill();

	const first = pool.splice(0, pool.length);
	return {
		first,
		async next(asked: Question[]): Promise<Question[]> {
			const askedIds = new Set(asked.map((q) => q.id));
			// Serve immediately when something is waiting; otherwise wait
			// for the poller until new questions arrive or the job ends.
			for (;;) {
				const fresh = pool.filter((q) => !askedIds.has(q.id));
				if (fresh.length > 0) {
					for (const q of fresh) {
						const index = pool.indexOf(q);
						if (index >= 0) pool.splice(index, 1);
					}
					return fresh;
				}
				if (done) {
					if (failure && asked.length === 0) throw failure;
					return [];
				}
				await sleep(1000);
			}
		},
		cancel(): void {
			done = true;
			child.kill();
		},
	};
}

function toPluginQuestion(q: EngineQuestion, config: SessionConfig): Question {
	const type = q.type === "multi" || q.type === "integer" || q.type === "decimal" ? q.type : "mcq";
	const difficulty: Difficulty =
		q.difficulty === "easy" || q.difficulty === "hard" ? q.difficulty : "medium";
	const sourceTitle = q.source_title?.trim();
	return {
		id: q.id,
		type,
		questionText: q.question_text,
		options: q.options && q.options.length > 0 ? q.options : undefined,
		correctAnswer: q.correct_answers?.length
			? q.correct_answers.join("\n")
			: q.correct_answer,
		correctAnswers: q.correct_answers?.length ? q.correct_answers : undefined,
		explanation: q.explanation,
		sourceTopics: [sourceTitle || config.topics[0]?.title || "Practice"],
		difficulty,
	};
}
