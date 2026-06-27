import { Question, TopicNote } from "../types";
import { TopicContext } from "../llm/prompt";
import { normalizeQuestionDifficulty } from "./difficulty-quality";

export function calibrateQuestionsForPractice(
	questions: Question[],
	topicContexts: TopicContext[],
	topics: TopicNote[]
): Question[] {
	return questions
		.map((question) => calibrateQuestionForPractice(question, topicContexts))
		.filter((question) => !isLowConceptRecallQuestion(question, topics));
}

export function calibrateQuestionForPractice(
	question: Question,
	topicContexts: TopicContext[]
): Question {
	const inferredSubtopics = inferSourceSubtopics(question, topicContexts);
	const sourceSubtopics = mergeUnique(
		[...(question.sourceSubtopics ?? []), ...inferredSubtopics]
	)
		.filter((subtopic) => !isTopicTitle(subtopic, question.sourceTopics))
		.slice(0, 6);
	const calibrated: Question = {
		...question,
		sourceSubtopics,
	};
	calibrated.difficulty = normalizeQuestionDifficulty(calibrated);
	return calibrated;
}

export function isLowConceptRecallQuestion(
	question: Question,
	topics: TopicNote[]
): boolean {
	if (question.difficulty !== "easy") return false;
	const normalizedQuestion = normalizeText(question.questionText);
	const directRecall = /\b(what does it do|which element|which half|what is returned|who introduced|according to|in the note|what is the name)\b/.test(normalizedQuestion);
	if (!directRecall) return false;

	const hasConceptAnchor = (question.sourceSubtopics ?? []).some((subtopic) =>
		!isTopicTitle(subtopic, question.sourceTopics)
	);
	if (hasConceptAnchor) return false;

	const titleFramed = topics.some((topic) => {
		const title = normalizeText(topic.title);
		return title.length >= 8 && normalizedQuestion.includes(title);
	});
	return titleFramed;
}

export function inferSourceSubtopics(
	question: Question,
	topicContexts: TopicContext[]
): string[] {
	const combined = normalizeText([
		question.questionText,
		question.correctAnswer,
		question.explanation,
		...(question.options ?? []),
		...(question.sourceSubtopics ?? []),
	].join(" "));
	const contexts = topicContexts.filter((context) =>
		question.sourceTopics.length === 0 ||
		question.sourceTopics.some((topic) =>
			titlesOverlap(topic, context.note.title)
		)
	);
	const scored: Array<{ heading: string; score: number }> = [];

	for (const context of contexts) {
		const headings = context.structure?.headings ?? [];
		const sections = context.structure?.sections ?? [];
		for (const heading of headings) {
			addHeadingScore(scored, heading.heading, combined, 2);
		}
		for (const section of sections) {
			addHeadingScore(scored, section.heading, combined, section.wordCount > 0 ? 1.5 : 1);
		}
	}

	return scored
		.filter((item) => item.score >= 1.4)
		.sort((a, b) => b.score - a.score || a.heading.localeCompare(b.heading))
		.map((item) => item.heading)
		.filter((heading, index, arr) =>
			arr.findIndex((candidate) => normalizeText(candidate) === normalizeText(heading)) === index
		)
		.slice(0, 4);
}

function addHeadingScore(
	output: Array<{ heading: string; score: number }>,
	heading: string,
	combinedQuestion: string,
	weight: number
): void {
	const key = normalizeText(heading);
	if (!key || key === "body") return;
	if (combinedQuestion.includes(key)) {
		output.push({ heading, score: weight + Math.min(2, key.length / 24) });
		return;
	}

	const tokens = key.split(" ").filter((token) => token.length >= 4);
	if (tokens.length === 0) return;
	const overlap = tokens.filter((token) => combinedQuestion.includes(token)).length;
	const score = (overlap / tokens.length) * weight;
	if (score > 0) output.push({ heading, score });
}

function isTopicTitle(value: string, sourceTopics: string[]): boolean {
	const normalized = normalizeText(value);
	if (!normalized) return true;
	return sourceTopics.some((topic) => {
		const topicKey = normalizeText(topic);
		return normalized === topicKey || topicKey.includes(normalized) || normalized.includes(topicKey);
	});
}

function titlesOverlap(a: string, b: string): boolean {
	const left = normalizeText(a);
	const right = normalizeText(b);
	return left === right || left.includes(right) || right.includes(left);
}

function mergeUnique(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		const key = normalizeText(trimmed);
		if (!trimmed || !key || seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
