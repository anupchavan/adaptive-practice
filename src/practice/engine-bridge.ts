/**
 * Desktop bridge to the Whetstone native engine (the Rust sidecar the
 * desktop apps ship). When enabled and available, whole-session
 * generation delegates to its far stronger pipeline - seeded authoring,
 * machine verification, blind probes, clarity gating - and the plugin
 * receives finished, verified questions. Mobile and unsupported
 * providers fall back to the built-in TypeScript pipeline untouched.
 */

import { App, Platform } from "obsidian";
import type {
	AdaptivePracticeSettings,
	Difficulty,
	LlmProvider,
	Question,
	SessionConfig,
} from "../types";

const ENGINE_PROVIDERS: LlmProvider[] = ["anthropic", "gemini", "openai", "ollama", "claude-code", "codex"];

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

function vaultBasePath(app: App): string | null {
	const adapter = app.vault.adapter as unknown as { getBasePath?: () => string };
	return adapter.getBasePath ? adapter.getBasePath() : null;
}

const ENGINE_RELEASE_BASE =
	"https://github.com/anupchavan/whetstone-releases/releases/latest/download";

/** The per-platform engine asset name, or null when none is published. */
export function engineAssetName(): string | null {
	if (Platform.isMobile) return null;
	const arch = process.arch;
	switch (process.platform) {
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

/** Resolve the engine binary, or null when this device cannot run it. */
export function engineBinaryPath(
	settings: AdaptivePracticeSettings,
	app?: App
): string | null {
	if (Platform.isMobile) return null;
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("fs") as typeof import("fs");
	const explicit = settings.nativeEnginePath.trim();
	const home = process.env.HOME ?? "";
	const candidates = explicit.length > 0 ? [explicit] : [
		app ? downloadedEnginePath(app) ?? "" : "",
		"/Applications/Whetstone.app/Contents/MacOS/whetstone-sidecar",
		`${home}/Applications/Whetstone.app/Contents/MacOS/whetstone-sidecar`,
		`${home}/Projects/whetstone/target/release/whetstone`,
		`${process.env.LOCALAPPDATA ?? ""}\\Whetstone\\whetstone-engine.exe`,
	];
	for (const candidate of candidates) {
		try {
			if (candidate && fs.existsSync(candidate)) return candidate;
		} catch {
			// unreadable candidate - keep looking
		}
	}
	return null;
}

/**
 * The plugin works without the Whetstone app: when no binary is found,
 * fetch the platform's engine from the public releases into the plugin's
 * own bin directory. One-time, ~7 MB, desktop only.
 */
export async function ensureEngine(
	app: App,
	settings: AdaptivePracticeSettings
): Promise<string | null> {
	const existing = engineBinaryPath(settings, app);
	if (existing) return existing;
	const target = downloadedEnginePath(app);
	const asset = engineAssetName();
	if (!target || !asset) return null;
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("fs") as typeof import("fs");
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const path = require("path") as typeof import("path");
	const response = await fetch(`${ENGINE_RELEASE_BASE}/${asset}`);
	if (!response.ok) return null;
	const bytes = Buffer.from(await response.arrayBuffer());
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, bytes);
	if (process.platform !== "win32") fs.chmodSync(target, 0o755);
	return target;
}


export interface EngineSession {
	/** The early-ready opening batch (the engine streams the rest). */
	first: Question[];
	/** New questions accumulated since `asked`; [] once generation ends. */
	next(asked: Question[]): Promise<Question[]>;
	cancel(): void;
}

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
	const binary = await ensureEngine(app, settings);
	const base = vaultBasePath(app);
	if (!binary || !base) {
		throw new Error(
			"The native engine could not be found or downloaded. Set an explicit path in settings."
		);
	}
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { spawn } = require("child_process") as typeof import("child_process");
	const dataDir = `${base}/${app.vault.configDir}/plugins/adaptive-practice/engine-data`;
	const child = spawn(binary, ["serve"], {
		env: { ...process.env, WHETSTONE_DATA_DIR: dataDir },
		stdio: ["pipe", "pipe", "pipe"],
	});

	let nextId = 1;
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	let buffer = "";
	child.stdout.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line.trim()) continue;
			try {
				const message = JSON.parse(line) as { id: number; ok?: boolean; data?: unknown; error?: string };
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

	interface EngineResponse {
		status: string;
		question_set?: { questions: EngineQuestion[] };
		job?: { job_id: string; state: string; error?: string } | null;
	}

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
		await new Promise((r) => setTimeout(r, 3000));
		response = await request<EngineResponse>("preparation_status", { job_id: jobId });
	}
	absorb(response);
	if (!response.job) done = true;

	// Background poller: keep absorbing until the job settles.
	const poll = async (): Promise<void> => {
		while (!done) {
			await new Promise((r) => setTimeout(r, 3000));
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
				await new Promise((r) => setTimeout(r, 1000));
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
