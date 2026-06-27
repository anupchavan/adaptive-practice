import { App, TFile } from "obsidian";
import { QuizResult, TopicNote } from "../types";

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
		const result = r.isCorrect ? "Correct" : "Incorrect";
		lines.push(
			`- **Q:** ${r.question.questionText} | **Type:** ${r.question.type.toUpperCase()} | **Difficulty:** ${r.question.difficulty}`
		);
		if (r.question.sourceSubtopics && r.question.sourceSubtopics.length > 0) {
			lines.push(
				`  - **Subtopics:** ${r.question.sourceSubtopics.join(", ")}`
			);
		}
		lines.push(
			`  - **Your answer:** ${r.userAnswer} | **Correct answer:** ${r.question.correctAnswer} | **Result:** ${result}`
		);
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
	for (const topicTitle of result.question.sourceTopics) {
		const topic = topics.find((t) => t.title === topicTitle);
		if (!topic) continue;
		await appendQuestionHistory(app, topic.path, [result]);
	}
}

export async function removeSingleQuestion(
	app: App,
	topics: TopicNote[],
	result: QuizResult
): Promise<void> {
	const marker = buildQuestionMarker(result);
	for (const topicTitle of result.question.sourceTopics) {
		const topic = topics.find((t) => t.title === topicTitle);
		if (!topic) continue;
		const file = app.vault.getAbstractFileByPath(topic.path);
		if (!(file instanceof TFile)) continue;
		const content = await app.vault.read(file);
		const idx = content.indexOf(marker);
		if (idx === -1) continue;

		let end = content.indexOf("\n- **Q:**", idx + marker.length);
		if (end === -1) {
			let nextSection = content.indexOf("\n### ", idx + marker.length);
			if (nextSection === -1) nextSection = content.length;
			end = nextSection;
		}

		const before = content.slice(0, idx);
		const after = content.slice(end);
		let newContent = before + after;

		const sessionHeaderRe = /\n### Session: [^\n]+\n(?=\n### Session:|\n*$)/;
		newContent = newContent.replace(sessionHeaderRe, "\n");

		await app.vault.modify(file, newContent);
	}
}

function buildQuestionMarker(r: QuizResult): string {
	return `- **Q:** ${r.question.questionText} | **Type:** ${r.question.type.toUpperCase()} | **Difficulty:** ${r.question.difficulty}`;
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
