import { App, TFile } from "obsidian";
import { QuizResult, TopicNote } from "../types";
import { resolveQuestionTargetTopics } from "../practice/source-map";
import {
	buildQuestionHistoryBlock,
	removeQuestionHistoryEntry,
} from "./history-format";

const HISTORY_HEADING = "## Practice history";
const HISTORY_COMMENT =
	"<!-- Adaptive Practice log - do not edit above this line -->";

export async function appendQuestionHistory(
	app: App,
	path: string,
	results: QuizResult[]
): Promise<void> {
	if (path.endsWith(".pdf")) return;
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return;

	const now = new Date();
	const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

	const lines: string[] = [];
	lines.push(`\n### Session: ${timestamp}`);
	for (const r of results) {
		lines.push(buildQuestionHistoryBlock(r));
	}

	const content = await app.vault.read(file);
	const historyIdx = content.indexOf(HISTORY_HEADING);

	let newContent: string;
	if (historyIdx === -1) {
		newContent =
			content.trimEnd() +
			"\n\n" +
			HISTORY_HEADING +
			"\n" +
			HISTORY_COMMENT +
			lines.join("\n") +
			"\n";
	} else {
		newContent = content.trimEnd() + lines.join("\n") + "\n";
	}

	await app.vault.modify(file, newContent);
}

export async function appendSingleQuestion(
	app: App,
	topics: TopicNote[],
	result: QuizResult
): Promise<void> {
	for (const topic of resolveQuestionTargetTopics(topics, result)) {
		await appendQuestionHistory(app, topic.path, [result]);
	}
}

export async function removeSingleQuestion(
	app: App,
	topics: TopicNote[],
	result: QuizResult
): Promise<void> {
	for (const topic of resolveQuestionTargetTopics(topics, result)) {
		const file = app.vault.getAbstractFileByPath(topic.path);
		if (!(file instanceof TFile)) continue;
		const content = await app.vault.read(file);
		const removed = removeQuestionHistoryEntry(content, result);
		if (!removed.removed) continue;
		await app.vault.modify(file, removed.content);
	}
}

export async function updateSkill(
	app: App,
	path: string,
	newSkill: number,
	savePdfSkill?: (path: string, skill: number) => Promise<void>
): Promise<void> {
	const rounded = Math.round(newSkill * 10) / 10;

	if (path.endsWith(".pdf")) {
		if (savePdfSkill) await savePdfSkill(path, rounded);
		return;
	}

	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return;

	await app.fileManager.processFrontMatter(file, (fm) => {
		const frontmatter = fm as Record<string, unknown>;
		frontmatter["skill"] = rounded;
	});
}
