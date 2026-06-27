import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const outdir = await mkdtemp(join(tmpdir(), "adaptive-practice-tests-"));
const outfile = join(outdir, "adaptive-core.test.mjs");

try {
	await esbuild.build({
		entryPoints: ["tests/adaptive-core.test.ts"],
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node18",
		outfile,
		logLevel: "silent",
	});
	await import(pathToFileURL(outfile).href);
	if (globalThis.__adaptivePracticeTests) {
		await globalThis.__adaptivePracticeTests;
		delete globalThis.__adaptivePracticeTests;
	}
} finally {
	await rm(outdir, { recursive: true, force: true });
}
