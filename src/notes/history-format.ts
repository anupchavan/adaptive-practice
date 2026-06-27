import { QuizResult } from "../types";

export function buildQuestionHistoryBlock(result: QuizResult): string {
	const marker = questionBlockMarker(result);
	const status = result.skipped
		? "Skipped"
		: result.isCorrect
			? "Correct"
			: "Incorrect";
	const bits = [
		`<!-- Adaptive Practice question: ${marker} -->`,
		`#### Question ${result.question.id ? `(${result.question.id})` : ""}`.trimEnd(),
		`**Type:** ${result.question.type.toUpperCase()}  `,
		`**Difficulty:** ${capitalize(result.question.difficulty)}  `,
		`**Result:** ${status}  `,
		`**Time:** ${formatDuration(result.timeTakenMs)}`,
	];

	if (result.question.sourceTopics.length > 0) {
		bits.push(`**Source topics:** ${result.question.sourceTopics.join(", ")}`);
	}
	if ((result.question.sourceSubtopics ?? []).length > 0) {
		bits.push(`**Source subtopics:** ${result.question.sourceSubtopics!.join(", ")}`);
	}

	bits.push(
		"",
		"**Question**",
		"",
		result.question.questionText.trim(),
		"",
		"**Your answer**",
		"",
		formatAnswer(result),
		"",
		"**Correct answer**",
		"",
		result.question.correctAnswer.trim(),
		"",
		"**Explanation**",
		"",
		result.question.explanation.trim(),
		`<!-- /Adaptive Practice question: ${marker} -->`
	);

	return bits.join("\n");
}

export function removeQuestionHistoryEntry(
	content: string,
	result: QuizResult
): { content: string; removed: boolean } {
	const marker = questionBlockMarker(result);
	const begin = `<!-- Adaptive Practice question: ${marker} -->`;
	const end = `<!-- /Adaptive Practice question: ${marker} -->`;
	const beginIndex = content.indexOf(begin);
	if (beginIndex !== -1) {
		const endIndex = content.indexOf(end, beginIndex + begin.length);
		if (endIndex !== -1) {
			const afterEnd = endIndex + end.length;
			return {
				content: cleanupEmptySessions(
					trimBlockGap(content.slice(0, beginIndex), content.slice(afterEnd))
				),
				removed: true,
			};
		}
	}

	return removeLegacyQuestionEntry(content, result);
}

export function questionBlockMarker(result: QuizResult): string {
	return hashString([
		result.question.questionText,
		result.question.correctAnswer,
		result.question.type,
		result.question.difficulty,
		...result.question.sourceTopics,
	].join("\n"));
}

function removeLegacyQuestionEntry(
	content: string,
	result: QuizResult
): { content: string; removed: boolean } {
	const marker = legacyQuestionMarker(result);
	const idx = content.indexOf(marker);
	if (idx === -1) return { content, removed: false };

	let end = content.indexOf("\n- **Q:**", idx + marker.length);
	if (end === -1) {
		let nextSection = content.indexOf("\n### ", idx + marker.length);
		if (nextSection === -1) nextSection = content.length;
		end = nextSection;
	}

	return {
		content: cleanupEmptySessions(content.slice(0, idx) + content.slice(end)),
		removed: true,
	};
}

function legacyQuestionMarker(result: QuizResult): string {
	return `- **Q:** ${result.question.questionText} | **Type:** ${result.question.type.toUpperCase()} | **Difficulty:** ${result.question.difficulty}`;
}

function cleanupEmptySessions(content: string): string {
	return content.replace(/\n### Session: [^\n]+\n(?=\n*(?:### Session:|\s*$))/g, "\n");
}

function trimBlockGap(before: string, after: string): string {
	const left = before.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}$/g, "\n\n");
	const right = after.replace(/^\n{3,}/g, "\n\n");
	if (!left || !right) return left + right;
	return left + right;
}

function formatAnswer(result: QuizResult): string {
	if (result.skipped) return "_Skipped_";
	return result.userAnswer.trim() || "_Blank_";
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function hashString(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(36);
}
