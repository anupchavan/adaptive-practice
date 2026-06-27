import { Question, TopicNote } from "../types";

export function reconcileGeneratedQuestions(
	questions: Question[],
	topics: TopicNote[]
): Question[] {
	return questions.map((question) => ({
		...question,
		sourceTopics: reconcileSourceTopics(question.sourceTopics, topics),
		sourceSubtopics: normalizeStringList(question.sourceSubtopics ?? []),
	}));
}

export function reconcileSourceTopics(
	sourceTopics: string[],
	topics: TopicNote[]
): string[] {
	if (topics.length === 0) return normalizeStringList(sourceTopics);

	const matched: string[] = [];
	for (const source of normalizeStringList(sourceTopics)) {
		const topic = findTopicMatch(source, topics);
		if (topic && !matched.includes(topic.title)) {
			matched.push(topic.title);
		}
	}

	if (matched.length > 0) return matched;
	if (topics.length === 1) return [topics[0]!.title];
	if (sourceTopics.length === 0) return topics.map((topic) => topic.title);
	return normalizeStringList(sourceTopics);
}

function findTopicMatch(source: string, topics: TopicNote[]): TopicNote | null {
	const sourceKey = normalizeTopicKey(source);
	if (!sourceKey) return null;

	for (const topic of topics) {
		if (topicAliases(topic).some((alias) => alias === sourceKey)) {
			return topic;
		}
	}

	const scored = topics
		.map((topic) => ({
			topic,
			score: Math.max(
				...topicAliases(topic).map((alias) => topicSimilarity(sourceKey, alias))
			),
		}))
		.sort((a, b) => b.score - a.score);
	const best = scored[0];
	return best && best.score >= 0.62 ? best.topic : null;
}

function topicAliases(topic: TopicNote): string[] {
	const withoutExtension = topic.path.replace(/\.[^.]+$/, "");
	const basename = withoutExtension.split("/").pop() ?? withoutExtension;
	return [
		topic.title,
		topic.path,
		withoutExtension,
		basename,
	].map(normalizeTopicKey).filter(Boolean);
}

function topicSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length >= 8 && b.includes(a)) return 0.8;
	if (b.length >= 8 && a.includes(b)) return 0.8;
	const aTokens = new Set(a.split(" ").filter((token) => token.length > 2));
	const bTokens = new Set(b.split(" ").filter((token) => token.length > 2));
	if (aTokens.size === 0 || bTokens.size === 0) return 0;
	let overlap = 0;
	for (const token of aTokens) {
		if (bTokens.has(token)) overlap++;
	}
	return overlap / Math.max(aTokens.size, bTokens.size);
}

function normalizeStringList(values: string[]): string[] {
	const normalized: string[] = [];
	for (const value of values) {
		const trimmed = String(value).trim();
		if (trimmed && !normalized.includes(trimmed)) normalized.push(trimmed);
	}
	return normalized;
}

function normalizeTopicKey(input: string): string {
	return input
		.toLowerCase()
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[_-]+/g, " ")
		.replace(/[^a-z0-9/ ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
