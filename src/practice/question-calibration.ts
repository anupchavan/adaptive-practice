import { Question, TopicNote } from "../types";
import { TopicContext } from "../llm/prompt";
import { normalizeQuestionDifficulty } from "./difficulty-quality";
import { extractConceptCandidates } from "../notes/concepts";

export function calibrateQuestionsForPractice(
	questions: Question[],
	topicContexts: TopicContext[],
	topics: TopicNote[]
): Question[] {
	return questions
		.map((question) => calibrateQuestionForPractice(question, topicContexts, topics))
		.filter((question) =>
			!isLowConceptRecallQuestion(question, topics) &&
			!isTitleDependentProblemQuestion(question, topics) &&
			!isMissingVisualReferenceQuestion(question) &&
			!isAnswerLeakQuestion(question) &&
			!hasNearDuplicateOptions(question)
		)
		.map((question) => linkSourceTopicMentions(question, topics));
}

/**
 * The stem gives the answer away: an MCQ whose full correct-option text
 * appears verbatim in the question. Numeric questions are exempt (stems
 * legitimately restate given numbers), as are very short option strings that
 * occur naturally in technical prose.
 */
export function isAnswerLeakQuestion(question: Question): boolean {
	if (question.type !== "mcq" && question.type !== "multi") return false;
	const stem = normalizeText(question.questionText);
	const answers = question.type === "multi"
		? question.correctAnswers ?? question.correctAnswer.split("\n")
		: [question.correctAnswer];
	return answers.some((answer) => {
		const key = normalizeText(answer);
		return key.length >= 12 && stem.includes(key);
	});
}

/**
 * Options that collapse to the same normalized text (case, punctuation, or
 * whitespace variants) make the question unanswerable; the parser only
 * enforces exact-string uniqueness.
 */
export function hasNearDuplicateOptions(question: Question): boolean {
	if (question.type !== "mcq" || !question.options) return false;
	// Pure-symbol options ("/", "$") normalize to nothing; key them by their
	// raw text so they stay distinct instead of colliding as empties.
	const keys = question.options.map((option) => {
		const key = normalizeText(option);
		return key || `raw:${option.trim()}`;
	});
	return new Set(keys).size !== question.options.length;
}

export function calibrateQuestionForPractice(
	question: Question,
	topicContexts: TopicContext[],
	topics: TopicNote[] = []
): Question {
	const inferredSubtopics = inferSourceSubtopics(question, topicContexts);
	const sourceSubtopics = mergeUnique(
		[...inferredSubtopics, ...(question.sourceSubtopics ?? [])]
			.map((subtopic) =>
				canonicalizeSourceSubtopic(subtopic, question.sourceTopics, topics)
			)
			.filter((subtopic): subtopic is string => !!subtopic)
	)
		.filter((subtopic) => !isTopicLabel(subtopic, question.sourceTopics, topics))
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
		!isTopicLabel(subtopic, question.sourceTopics, topics)
	);
	if (hasConceptAnchor) return false;

	const titleFramed = topics.some((topic) => {
		return topicLabelKeys(topic).some((title) =>
			title.length >= 8 && normalizedQuestion.includes(title)
		);
	});
	return titleFramed;
}

export function isTitleDependentProblemQuestion(
	question: Question,
	topics: TopicNote[]
): boolean {
	const normalizedQuestion = normalizeText(question.questionText);
	const matchedLabels = topics.flatMap(topicLabelKeys)
		.filter((label) => label.length >= 8 && normalizedQuestion.includes(label));
	if (matchedLabels.length === 0) return false;
	if (!hasNamedProblemFraming(normalizedQuestion, matchedLabels)) return false;
	return !hasSelfContainedProblemSetup(question.questionText);
}

export function isMissingVisualReferenceQuestion(question: Question): boolean {
	const normalizedQuestion = normalizeText(question.questionText);
	const refersToShownVisual =
		/\b(?:diagram|figure|image|screenshot|svg|whiteboard|chart|graph)\b/.test(normalizedQuestion) &&
		/\b(?:shown|above|below|following|pictured|illustrated|in the image|in the diagram)\b/.test(normalizedQuestion);
	if (!refersToShownVisual) return false;
	return !hasInlineVisual(question.questionText);
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
			topicMatchesContext(topic, context.note)
		)
	);
	const scored: Array<{ heading: string; score: number }> = [];

	for (const context of contexts) {
		const headings = context.structure?.headings ?? [];
		const sections = context.structure?.sections ?? [];
		const concepts = context.structure
			? extractConceptCandidates(context.structure, 24)
			: [];
		for (const heading of headings) {
			addHeadingScore(scored, heading.heading, combined, 2);
		}
		for (const section of sections) {
			addHeadingScore(scored, section.heading, combined, section.wordCount > 0 ? 1.5 : 1);
		}
		for (const concept of concepts) {
			addHeadingScore(scored, concept, combined, 2.2);
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

export function linkSourceTopicMentions(
	question: Question,
	topics: TopicNote[]
): Question {
	const replacements = sourceTopicLinkReplacements(question, topics);
	if (replacements.length === 0) return question;

	return {
		...question,
		questionText: linkTopicMentions(question.questionText, replacements),
	};
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

interface TopicLinkReplacement {
	label: string;
	target: string;
}

function sourceTopicLinkReplacements(
	question: Question,
	topics: TopicNote[]
): TopicLinkReplacement[] {
	const sourceKeys = new Set(question.sourceTopics.map(normalizeText).filter(Boolean));
	const replacements: TopicLinkReplacement[] = [];
	const seen = new Set<string>();

	for (const topic of topics) {
		const labels = [topic.title, ...(topic.aliases ?? [])].filter(Boolean);
		const matchesSource = labels.some((label) => sourceKeys.has(normalizeText(label)));
		if (!matchesSource) continue;

		const target = topic.path.replace(/\.md$/i, "");
		for (const label of labels) {
			const trimmed = label.trim();
			const key = normalizeText(trimmed);
			if (!trimmed || key.length < 3 || seen.has(key)) continue;
			seen.add(key);
			replacements.push({
				label: trimmed,
				target,
			});
		}
	}

	return replacements.sort((a, b) => b.label.length - a.label.length);
}

function linkTopicMentions(
	markdown: string,
	replacements: TopicLinkReplacement[]
): string {
	// Link each distinct note at most once across the whole question — a note
	// mentioned several times should only be a link on its first appearance.
	const linkedTargets = new Set<string>();
	return replaceOutsideCode(markdown, (chunk) => {
		let next = chunk;
		for (const replacement of replacements) {
			next = replaceTopicLabel(next, replacement, linkedTargets);
		}
		return next;
	});
}

function replaceTopicLabel(
	text: string,
	replacement: TopicLinkReplacement,
	linkedTargets: Set<string>
): string {
	if (linkedTargets.has(replacement.target)) return text;
	const labelPattern = escapeRegExp(replacement.label);
	const boldPattern = new RegExp(`\\*\\*(${labelPattern})\\*\\*`, "gi");
	const plainPattern = new RegExp(`(^|[^A-Za-z0-9])(${labelPattern})(?=$|[^A-Za-z0-9])`, "gi");

	return text
		.replace(boldPattern, (matched: string, display: string, offset: number, full: string) => {
			if (linkedTargets.has(replacement.target) || shouldSkipLinkReplacement(full, offset)) {
				return matched;
			}
			linkedTargets.add(replacement.target);
			return buildWikiLink(replacement.target, display);
		})
		.replace(plainPattern, (match: string, prefix: string, display: string, offset: number, full: string) => {
			if (
				linkedTargets.has(replacement.target) ||
				shouldSkipLinkReplacement(full, offset + prefix.length)
			) {
				return match;
			}
			linkedTargets.add(replacement.target);
			return `${prefix}${buildWikiLink(replacement.target, display)}`;
		});
}

function replaceOutsideCode(
	markdown: string,
	replaceChunk: (chunk: string) => string
): string {
	const segments = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g);
	return segments
		.map((segment) =>
			segment.startsWith("```") ||
			segment.startsWith("~~~") ||
			(segment.startsWith("`") && segment.endsWith("`"))
				? segment
				: replaceChunk(segment)
		)
		.join("");
}

function shouldSkipLinkReplacement(
	full: string,
	offset: number
): boolean {
	return isInsideWikiLink(full, offset);
}

function isInsideWikiLink(
	full: string,
	offset: number
): boolean {
	const open = full.lastIndexOf("[[", offset);
	if (open === -1) return false;
	const close = full.lastIndexOf("]]", offset);
	return close < open;
}

function buildWikiLink(
	target: string,
	display: string
): string {
	return `[[${escapeWikiLinkPart(target)}|${escapeWikiLinkPart(display)}]]`;
}

function escapeWikiLinkPart(value: string): string {
	return value.replace(/\[|\]/g, "").replace(/\|/g, " ").trim();
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTopicLabel(
	value: string,
	sourceTopics: string[],
	topics: TopicNote[]
): boolean {
	const normalized = normalizeText(value);
	if (!normalized) return true;
	return sourceTopics.some((topic) => {
		const topicKey = normalizeText(topic);
		return isBareTopicLabel(normalized, topicKey);
	}) || topics.some((topic) =>
		topicLabelKeys(topic).some((topicKey) =>
			isBareTopicLabel(normalized, topicKey)
		)
	);
}

function canonicalizeSourceSubtopic(
	value: string,
	sourceTopics: string[],
	topics: TopicNote[]
): string | null {
	const trimmed = value.trim();
	const normalized = normalizeText(trimmed);
	if (!normalized) return null;
	const labels = [
		...sourceTopics.map(normalizeText),
		...topics.flatMap(topicLabelKeys),
	].filter(Boolean);

	for (const label of labels) {
		const withoutLabel = removeTopicLabel(trimmed, normalized, label);
		if (withoutLabel === null) continue;
		const cleaned = withoutLabel.trim();
		if (
			!cleaned ||
			isGenericLabelRemainder(cleaned) ||
			isTopicLabel(cleaned, sourceTopics, topics)
		) {
			return null;
		}
		return cleaned;
	}
	return trimmed;
}

function removeTopicLabel(
	original: string,
	normalized: string,
	topicKey: string
): string | null {
	if (!isBareTopicLabel(normalized, topicKey) && !normalized.includes(topicKey)) {
		return null;
	}
	const originalTokens = original
		.replace(/[^A-Za-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const candidateTokens = normalized.split(" ").filter(Boolean);
	const topicTokens = topicKey.split(" ").filter(Boolean);
	if (candidateTokens.length === 0 || topicTokens.length === 0) return null;
	if (candidateTokens.every((token) => topicTokens.includes(token))) return "";

	if (startsWithTokens(candidateTokens, topicTokens)) {
		return trimConnectorTokens(originalTokens.slice(topicTokens.length)).join(" ");
	}
	if (endsWithTokens(candidateTokens, topicTokens)) {
		return trimConnectorTokens(originalTokens.slice(0, -topicTokens.length)).join(" ");
	}

	const topicSet = new Set(topicTokens);
	return trimConnectorTokens(originalTokens
		.filter((_, index) => !topicSet.has(candidateTokens[index] ?? ""))
	).join(" ");
}

function isBareTopicLabel(candidate: string, topicKey: string): boolean {
	if (!topicKey) return false;
	if (candidate === topicKey) return true;

	const candidateTokens = candidate.split(" ").filter(Boolean);
	const topicTokens = topicKey.split(" ").filter(Boolean);
	if (candidateTokens.length === 0 || topicTokens.length === 0) return false;
	const candidateSet = new Set(candidateTokens);
	const topicSet = new Set(topicTokens);

	const candidateInsideTopic = candidateTokens.every((token) => topicSet.has(token));
	if (candidateInsideTopic) return true;

	const topicInsideCandidate = topicTokens.every((token) => candidateSet.has(token));
	if (!topicInsideCandidate) return false;
	const extras = candidateTokens.filter((token) => !topicSet.has(token));
	return extras.length > 0 && extras.every(isGenericTopicLabelToken);
}

function isGenericTopicLabelToken(token: string): boolean {
	return /^(note|notes|topic|topics|chapter|unit|overview|problem|problems|section|sections|intro|introduction|scratchpad|guide)$/.test(token);
}

function isGenericLabelRemainder(value: string): boolean {
	const tokens = normalizeText(value).split(" ").filter(Boolean);
	return tokens.length > 0 && tokens.every(isGenericTopicLabelToken);
}

function trimConnectorTokens(tokens: string[]): string[] {
	const connector = /^(in|for|of|on|about|from|the|a|an)$/i;
	let start = 0;
	let end = tokens.length;
	while (start < end && connector.test(tokens[start]!)) start++;
	while (end > start && connector.test(tokens[end - 1]!)) end--;
	return tokens.slice(start, end);
}

function startsWithTokens(candidate: string[], prefix: string[]): boolean {
	return prefix.every((token, index) => candidate[index] === token);
}

function endsWithTokens(candidate: string[], suffix: string[]): boolean {
	const offset = candidate.length - suffix.length;
	if (offset < 0) return false;
	return suffix.every((token, index) => candidate[offset + index] === token);
}

function topicMatchesContext(sourceTopic: string, note: TopicNote): boolean {
	return topicLabelKeys(note).some((label) => titlesOverlap(sourceTopic, label));
}

function topicLabelKeys(topic: TopicNote): string[] {
	return [topic.title, ...(topic.aliases ?? [])]
		.map(normalizeText)
		.filter(Boolean);
}

function titlesOverlap(a: string, b: string): boolean {
	const left = normalizeText(a);
	const right = normalizeText(b);
	return left === right || left.includes(right) || right.includes(left);
}

function hasNamedProblemFraming(
	normalizedQuestion: string,
	labels: string[]
): boolean {
	if (/\bproblem\b/.test(normalizedQuestion)) return true;
	if (/\b(?:algorithm|approach|solution|complexity)\s+(?:for|of)\b/.test(normalizedQuestion)) {
		return true;
	}
	return labels.some((label) =>
		normalizedQuestion.includes(`${label} has time complexity`) ||
		normalizedQuestion.includes(`${label} algorithm`) ||
		normalizedQuestion.includes(`${label} approach`)
	);
}

function hasSelfContainedProblemSetup(questionText: string): boolean {
	if (/```|~~~|\[[^\]]*,[^\]]*\]|\b(?:nums|arr|array|piles|hours|target|rate|k|h)\s*=/i.test(questionText)) {
		return true;
	}
	const lower = questionText.toLowerCase();
	const hasGiven = /\b(?:given|you are given|input|suppose|consider)\b/.test(lower);
	const hasTaskVerb = /\b(?:return|find|search|minimize|maximize|determine|compute|decide|choose)\b/.test(lower);
	const hasDomainObject = /\b(?:array|list|string|graph|tree|piles?|bananas?|hours?|rate|element|target|subarray|matrix|number|integer)\b/.test(lower);
	const hasConstraint = /\b(?:where|such that|except|each|every|at most|at least|exactly|distinct|sorted)\b/.test(lower);
	return hasDomainObject && hasGiven && (hasTaskVerb || hasConstraint);
}

function hasInlineVisual(markdown: string): boolean {
	return /!\[[^\]]*]\([^)]+\)|!\[\[[^\]]+]]|<svg\b/i.test(markdown);
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
