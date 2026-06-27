import {
	PracticeMemory,
	QuestionFeedbackEntry,
	QuestionFeedbackKind,
	QuizResult,
} from "../types";
import { normalizePracticeMemory } from "./scheduler";

const MAX_QUESTION_FEEDBACK = 250;
const MAX_TEXT_CHARS = 480;

export function recordQuestionFeedback(
	memory: PracticeMemory | undefined,
	result: QuizResult,
	kind: QuestionFeedbackKind,
	now = Date.now()
): PracticeMemory {
	const next = normalizePracticeMemory(memory);
	const entry = buildQuestionFeedbackEntry(result, kind, now);
	next.questionFeedback = [
		...(next.questionFeedback ?? []).filter((item) =>
			item.id !== entry.id || item.kind !== entry.kind
		),
		entry,
	].slice(-MAX_QUESTION_FEEDBACK);
	return next;
}

function buildQuestionFeedbackEntry(
	result: QuizResult,
	kind: QuestionFeedbackKind,
	now: number
): QuestionFeedbackEntry {
	const question = result.question;
	return {
		id: questionFingerprint(result),
		kind,
		questionText: truncate(question.questionText),
		correctAnswer: truncate(question.correctAnswer),
		difficulty: question.difficulty,
		sourceTopics: [...new Set(question.sourceTopics)].slice(0, 8),
		sourceSubtopics: [...new Set(question.sourceSubtopics ?? [])].slice(0, 8),
		wasCorrect: result.isCorrect,
		skipped: result.skipped,
		timeTakenMs: Math.max(0, Math.round(result.timeTakenMs)),
		createdAt: now,
	};
}

function questionFingerprint(result: QuizResult): string {
	const question = result.question;
	return hashString([
		question.questionText,
		question.correctAnswer,
		question.sourceTopics.join("|"),
	].join("\n"));
}

function hashString(value: string): string {
	let hash = 2166136261;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return `qf-${(hash >>> 0).toString(36)}`;
}

function truncate(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length <= MAX_TEXT_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_TEXT_CHARS).trimEnd()}...`;
}
