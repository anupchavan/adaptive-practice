import {
	DailyChallengeMode,
	NoteMediaReference,
	NoteStructure,
	PromptAttachment,
	SubtopicPracticeState,
	TopicNote,
} from "../types";

const MAX_TOTAL_CONTENT_CHARS = 120_000;
const MAX_HISTORY_RATIO = 0.25;
const MAX_OUTLINE_ITEMS = 40;
const MAX_RENDERED_SECTIONS = 16;
const MIN_SECTION_CHARS = 280;
const MAX_SUBTOPIC_MEMORY_ITEMS = 12;
const MAX_CONCEPT_TARGETS = 18;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TopicContext {
	note: TopicNote;
	content: string;
	history: string;
	practicedSubtopics?: Record<string, SubtopicPracticeState>;
	structure?: NoteStructure;
	attachments?: PromptAttachment[];
	pdfData?: ArrayBuffer;
}

export interface StructuredPrompt {
	textPrompt: string;
	attachments: PromptAttachment[];
}

export interface PromptBuildOptions {
	challengeMode?: DailyChallengeMode;
	challengeReason?: string;
	now?: number;
}

export function buildPrompt(
	topics: TopicContext[],
	questionCount: number,
	options: PromptBuildOptions = {}
): StructuredPrompt {
	const challengeMode = options.challengeMode ?? "steady";
	const challengeReason = options.challengeReason?.trim() || "balanced challenge";
	const now = options.now ?? Date.now();
	const mdTopics = topics.filter((t) => !t.note.isPdf);
	const pdfTopics = topics.filter((t) => t.note.isPdf);
	const perTopicBudget = mdTopics.length === 0
		? MAX_TOTAL_CONTENT_CHARS
		: Math.floor(MAX_TOTAL_CONTENT_CHARS / mdTopics.length);
	const historyBudget = Math.floor(perTopicBudget * MAX_HISTORY_RATIO);
	const contentBudget = perTopicBudget - historyBudget;

	const topicBlocks = mdTopics
		.map((t) => renderTopicBlock(t, contentBudget, historyBudget, now))
		.join("\n");

	const pdfTopicBlocks = pdfTopics
		.map((t) => {
			const reason = t.note.scheduleReason ? `\nSchedule reason: ${t.note.scheduleReason}` : "";
			const aliases = renderAliases(t.note);
			return `### Topic: ${t.note.title} (skill: ${t.note.skill}/100) [PDF attached inline]${aliases}${reason}`;
		})
		.join("\n");

	const allTopicBlocks = [topicBlocks, pdfTopicBlocks].filter(Boolean).join("\n\n");

	const textPrompt = `You are Adaptive Practice, an Obsidian-native practice coach. Generate exactly ${questionCount} questions from the provided vault material. Your goal is durable learning and transfer, not trivia volume.

## Session calibration

Session mode: ${formatChallengeMode(challengeMode)}
Scheduler reason: ${challengeReason}
${challengeModeInstructions(challengeMode)}

## Core learning contract

1. Use retrieval practice: ask the learner to produce, choose, calculate, debug, compare, prove, or transfer an idea.
2. Use desirable difficulty: questions should be effortful but answerable from the notes plus prerequisite reasoning.
3. Use spacing and interleaving: prioritize topics marked due, low-skill, recently changed, or weak in past practice. When multiple topics are present, mix them naturally.
4. Use flow-friendly calibration: aim for a session that a prepared learner can get roughly 70-85% correct. Start with one approachable question only if needed, then move toward deeper transfer.
5. Avoid repeating exact subtopics from past practice unless the learner struggled or the scheduler says the topic is due.
6. Treat a note title as a source label, not automatically as the concept. Use headings, sections, frontmatter, diagrams, examples, and recurring terms to identify the actual concept being tested.
7. Ignore clipped webpage junk, navigation labels, cookie banners, and unrelated boilerplate even if it appears in the note.

Subtopic memory rule: each topic may include structured subtopic memory. Use "revisit" subtopics when they show misses, skips, slow/weak performance, or the topic is due. Avoid "mastered" subtopics unless they are needed as a stepping stone for transfer. Prefer headings or unpracticed sections for fresh questions.

## Difficulty calibration

Difficulty is domain-relative:

**Easy** = one clear reasoning step, direct application, or essential factual retrieval when the subject genuinely rewards facts.

**Medium** = 2-3 connected steps, choosing a method, interpreting a diagram/code/pathway, or spotting a common misconception.

**Hard** = genuinely non-routine transfer to a new setting, edge cases, proof/counterexample, multi-topic synthesis, debugging from symptoms, or a trap a competent learner might miss. A hard CS question should usually require tracing an algorithm, preserving an invariant under an awkward case, deriving complexity from a failure mode, comparing implementations, or finding a counterexample.

Label a question "hard" only if a prepared learner needs at least two substantial reasoning moves. Do not mark a direct fact lookup, single formula substitution, or one-iteration trace as hard. Hard distractors must be tempting for a real reason, not obviously silly.

Adjust the distribution based on skill level and recent results:
- Skill 0-30: 60% easy, 30% medium, 10% hard
- Skill 31-60: 30% easy, 45% medium, 25% hard
- Skill 61-80: 10% easy, 40% medium, 50% hard
- Skill 81-100: 0% easy, 25% medium, 75% hard

## Domain rules

- Computer science: prefer invariants, complexity, edge cases, trace tables, code behavior, debugging, and implementation tradeoffs. Do not ask biographical trivia unless the note is explicitly historical.
- Mathematics: prefer problem solving, representation changes, counterexamples, proof sketches, and method selection. Interleave similar-looking problem types.
- Physics: prefer modelling assumptions, units, limiting cases, diagrams, and numerical reasoning.
- Chemistry: prefer mechanism/structure-property reasoning, equilibria, thermodynamics, trends, and exceptions.
- Humanities/history: factual recall can be valid when facts are core, but connect facts to chronology, causality, comparison, or interpretation.

## Formatting and media

1. Use Obsidian-compatible Markdown.
2. Use LaTeX wrapped in dollar signs: $x^2$ inline and $$\\sum_{i=1}^{n} i$$ for display. Never output bare LaTeX.
3. Use fenced code blocks for code, traces, or pseudo-code when it clarifies the problem.
4. For MCQ, provide exactly 4 plausible options. Distractors should reflect common mistakes: sign errors, off-by-one errors, wrong formula choice, missing condition, overgeneralization, confusing best/worst/average case, or violating an invariant.
5. If images, SVG notes, or PDFs are attached or described, inspect and use them. Treat diagrams and whiteboard images as first-class source material.
6. Each question must list exact "sourceTopics" using the topic titles below, and "sourceSubtopics" using the concept target, section name, invariant, mechanism, or trap being tested. Do not put the note title in "sourceSubtopics" unless the note has no more specific concept.

## Topics

${allTopicBlocks}

## Response format

Respond with ONLY valid JSON. No markdown fences, no explanation. Prefer a JSON array. If your API requires a top-level object, return { "questions": [...] }. Each question element must match this schema:

{
  "id": "q1",
  "type": "mcq" | "integer" | "decimal",
  "questionText": "The full question text",
  "options": ["option text 1", "option text 2", "option text 3", "option text 4"],
  "correctAnswer": "option text 1" or "42" or "3.14",
  "explanation": "Brief explanation of why this is correct",
  "sourceTopics": ["Topic Title 1", "Topic Title 2"],
  "sourceSubtopics": ["Heading or subtopic 1"],
  "difficulty": "easy" | "medium" | "hard"
}

For MCQ: "options" is required, "correctAnswer" must exactly match one option. Do NOT prefix options with letters like "A)", "B)", etc.
For integer/decimal: "options" should be omitted, "correctAnswer" is the numeric string.

For explanation: be concise but include the key reasoning step, not just the final answer.

Generate exactly ${questionCount} questions now.`;

	const pdfAttachments = pdfTopics
		.filter((t) => t.pdfData && t.pdfData.byteLength > 0)
		.map((t) => ({
			noteTitle: t.note.title,
			path: t.note.path,
			kind: "pdf" as const,
			mimeType: "application/pdf",
			data: t.pdfData!,
		}));
	const mediaAttachments = mdTopics.flatMap((t) => t.attachments ?? []);

	return { textPrompt, attachments: [...pdfAttachments, ...mediaAttachments] };
}

function formatChallengeMode(mode: DailyChallengeMode): string {
	if (mode === "warmup") return "warm-up";
	return mode;
}

function challengeModeInstructions(mode: DailyChallengeMode): string {
	if (mode === "warmup") {
		return [
			"Calibration rule: this is a warm-up session for fragile recall.",
			"Favor confidence-building retrieval first: mostly easy/medium questions, one concept per question, no hard synthesis unless the note is already simple.",
			"Use mistakes, slow recall, skips, or new-note status as signals to ask diagnostic questions that reveal the misconception without overwhelming the learner.",
		].join("\n");
	}
	if (mode === "stretch") {
		return [
			"Calibration rule: this is a stretch session after strong recent accuracy and fluency.",
			"Favor transfer: mostly medium/hard questions, edge cases, mixed topics, proof/counterexample, diagrams, code traces, or JEE-style traps.",
			"Keep the questions answerable from the notes, but avoid direct copy-paste recall unless a fact is genuinely central.",
		].join("\n");
	}
	return [
		"Calibration rule: this is a steady session.",
		"Use the skill-based difficulty distribution below and sequence questions from approachable recall toward transfer.",
		"Keep challenge close to the learner's current level so the session feels focused rather than either trivial or punishing.",
	].join("\n");
}

function renderTopicBlock(
	topic: TopicContext,
	contentBudget: number,
	historyBudget: number,
	now: number
): string {
	const note = topic.note;
	const parts = [`### Topic: ${note.title} (skill: ${note.skill}/100)`];
	const aliases = renderAliases(note);
	if (aliases) parts.push(aliases.trim());
	if (note.scheduleReason) parts.push(`Schedule reason: ${note.scheduleReason}`);
	if (note.createdAt) parts.push(`Created: ${new Date(note.createdAt).toISOString()}`);
	if (note.updatedAt) parts.push(`Last updated: ${new Date(note.updatedAt).toISOString()}`);
	if (note.lastPracticedAt) {
		parts.push(`Last practiced: ${new Date(note.lastPracticedAt).toISOString()}`);
	}
	const memory = renderSubtopicMemory(topic, now);
	if (memory) parts.push(memory);

	if (topic.structure) {
		parts.push(renderStructure(topic, contentBudget, now));
	} else {
		parts.push(`<note_content>\n${truncateText(topic.content, contentBudget)}\n</note_content>`);
	}

	if (topic.history) {
		parts.push(`<past_practice>\n${truncateText(topic.history, historyBudget)}\n</past_practice>`);
	}

	return parts.join("\n");
}

function renderAliases(note: TopicNote): string {
	const aliases = (note.aliases ?? [])
		.map((alias) => alias.trim())
		.filter(Boolean)
		.slice(0, 8);
	if (aliases.length === 0) return "";
	return `\nAliases (context only; sourceTopics must use the Topic title): ${aliases.join(", ")}`;
}

function renderSubtopicMemory(topic: TopicContext, now: number): string {
	const entries = Object.entries(topic.practicedSubtopics ?? {})
		.map(([name, state]) => ({ name, state, score: subtopicMemoryScore(state, now) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_SUBTOPIC_MEMORY_ITEMS);
	if (entries.length === 0) return "";

	const topicDue = !!topic.note.dueAt && topic.note.dueAt <= now;
	const lines = entries.map(({ name, state }) => {
		const attempts = Math.max(0, state.attempts);
		const accuracy = attempts > 0 ? state.correct / attempts : 0;
		const lastPracticed = state.lastPracticedAt > 0
			? new Date(state.lastPracticedAt).toISOString()
			: "never";
		const guidance =
			accuracy < 0.7 || attempts < 2
				? "revisit"
				: topicDue
					? "revisit-if-central"
					: "avoid-if-possible";
		return `- ${name}: ${attempts} attempt${attempts === 1 ? "" : "s"}, ${Math.round(accuracy * 100)}% correct, last ${lastPracticed}, guidance=${guidance}`;
	});
	return `<subtopic_memory>\n${lines.join("\n")}\n</subtopic_memory>`;
}

function subtopicMemoryScore(state: SubtopicPracticeState, now: number): number {
	const attempts = Math.max(0, state.attempts);
	const accuracy = attempts > 0 ? state.correct / attempts : 0;
	const weakness = 1 - accuracy;
	const daysSincePractice = state.lastPracticedAt > 0
		? Math.max(0, (now - state.lastPracticedAt) / MS_PER_DAY)
		: Number.POSITIVE_INFINITY;
	const recency = Number.isFinite(daysSincePractice)
		? Math.max(0, 1 - daysSincePractice / 30)
		: 0;
	return weakness * 4 + Math.min(attempts, 5) * 0.3 + recency;
}

function renderStructure(topic: TopicContext, contentBudget: number, now: number): string {
	const structure = topic.structure!;
	const parts: string[] = [];
	const frontmatter = Object.entries(structure.frontmatter)
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	if (frontmatter) {
		parts.push(`<frontmatter>\n${frontmatter}\n</frontmatter>`);
	}

	if (structure.tags.length > 0) {
		parts.push(`Tags: ${structure.tags.join(", ")}`);
	}
	if (structure.links.length > 0) {
		parts.push(`Links: ${structure.links.slice(0, 30).join(", ")}`);
	}
	if (structure.headings.length > 0) {
		const outline = structure.headings
			.slice(0, MAX_OUTLINE_ITEMS)
			.map((heading) => `${"  ".repeat(Math.max(0, heading.level - 1))}- ${heading.heading}`)
			.join("\n");
		parts.push(`<outline>\n${outline}\n</outline>`);
	}
	const concepts = renderConceptTargets(structure);
	if (concepts) parts.push(concepts);
	if (structure.media.length > 0) {
		parts.push(renderMedia(structure.media));
	}

	parts.push(renderSections(topic, contentBudget, now));
	return parts.join("\n");
}

function renderConceptTargets(structure: NoteStructure): string {
	const candidates = [
		...structure.sections
			.filter((section) => section.heading !== "Body" && section.wordCount > 0)
			.map((section) => section.heading),
		...structure.headings.map((heading) => heading.heading),
		...structure.tags.map((tag) => tag.replace(/^#/, "")),
		...Object.entries(structure.frontmatter)
			.filter(([key]) => /topic|concept|chapter|exam|subject|unit|area/i.test(key))
			.map(([, value]) => value),
	];
	const unique = uniqueConcepts(candidates)
		.filter((concept) => normalizeHeading(concept) !== normalizeHeading(structure.title))
		.slice(0, MAX_CONCEPT_TARGETS);
	if (unique.length === 0) return "";
	return `<concept_targets>\n${unique.map((concept) => `- ${concept}`).join("\n")}\n</concept_targets>`;
}

function renderSections(topic: TopicContext, contentBudget: number, now: number): string {
	const structure = topic.structure!;
	const selected = selectSectionsForPrompt(topic, now);
	const sectionBudget = Math.max(
		MIN_SECTION_CHARS,
		Math.floor(contentBudget / Math.max(1, selected.length))
	);
	const renderedSections = selected
		.map((section) => {
			const heading = section.level > 0 ? `${"#".repeat(section.level)} ${section.heading}` : section.heading;
			const content = section.content
				? truncateText(section.content, sectionBudget)
				: "[section has a heading but no body text]";
			return `${heading}\n${content}`;
		})
		.join("\n\n");
	const omitted = structure.sections.length - selected.length;
	const omittedLine = omitted > 0
		? `\n\n[...${omitted} additional sections omitted from excerpts; use the outline above for their names]`
		: "";

	return `<note_sections>\n${renderedSections}${omittedLine}\n</note_sections>`;
}

function selectSectionsForPrompt(
	topic: TopicContext,
	now: number
): NoteStructure["sections"] {
	const sections = topic.structure?.sections ?? [];
	if (sections.length <= MAX_RENDERED_SECTIONS) return sections;

	const selected = new Map<number, NoteStructure["sections"][number]>();
	const add = (index: number): void => {
		const section = sections[index];
		if (section) selected.set(index, section);
	};

	add(0);
	const nonEmpty = sections
		.map((section, index) => ({ section, index }))
		.filter(({ section }) => section.wordCount > 0);
	if (nonEmpty.length > 0) {
		add(nonEmpty[0]!.index);
	}

	const prioritySlots = Math.max(1, Math.floor(MAX_RENDERED_SECTIONS / 3));
	const prioritized = sections
		.map((section, index) => ({
			index,
			score: sectionPromptPriority(section, topic, now),
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index);
	for (const { index } of prioritized) {
		if (selected.size >= prioritySlots + 2) break;
		add(index);
	}

	const slots = Math.max(1, MAX_RENDERED_SECTIONS - selected.size);
	const denominator = Math.max(1, slots - 1);
	for (let i = 0; i < slots; i++) {
		const index = Math.round((i * (sections.length - 1)) / denominator);
		add(index);
	}

	for (let i = 0; selected.size < MAX_RENDERED_SECTIONS && i < sections.length; i++) {
		add(i);
	}

	return [...selected.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, section]) => section);
}

function sectionPromptPriority(
	section: NoteStructure["sections"][number],
	topic: TopicContext,
	now: number
): number {
	if (section.wordCount <= 0) return 0;
	const heading = normalizeHeading(section.heading);
	if (!heading) return 0.25;

	const practiced = topic.practicedSubtopics ?? {};
	const practicedEntries = Object.entries(practiced);
	const matching = practicedEntries
		.filter(([name]) => headingsOverlap(heading, normalizeHeading(name)))
		.map(([, state]) => subtopicMemoryScore(state, now));
	if (matching.length > 0) {
		return 6 + Math.max(...matching);
	}

	const isUnpracticed = !practicedEntries.some(([name]) =>
		headingsOverlap(heading, normalizeHeading(name))
	);
	return isUnpracticed ? 1 : 0;
}

function normalizeHeading(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function uniqueConcepts(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const trimmed = value.trim();
		const key = normalizeHeading(trimmed);
		if (!trimmed || !key || seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function headingsOverlap(a: string, b: string): boolean {
	if (!a || !b) return false;
	return a === b || a.includes(b) || b.includes(a);
}

function renderMedia(media: NoteMediaReference[]): string {
	const lines: string[] = [];
	for (const item of media) {
		const sizeKb = Math.round(item.size / 1024);
		const bits = [
			item.kind,
			item.mimeType,
			item.source === "remote" ? "remote" : "local",
		];
		if (item.source !== "remote") bits.push(`${sizeKb} KB`);
		const labels = [
			item.alt ? `alt="${item.alt}"` : "",
			item.caption ? `caption="${truncateText(item.caption, 240)}"` : "",
			item.url ? `url="${item.url}"` : "",
		].filter(Boolean);
		lines.push(`- ${item.path} (${bits.join(", ")})${labels.length > 0 ? ` ${labels.join(" ")}` : ""}`);
		if (item.svgText) {
			lines.push(`<svg_source path="${item.path}">\n${truncateText(item.svgText, 4000)}\n</svg_source>`);
		}
	}
	return `<media>\n${lines.join("\n")}\n</media>`;
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	const truncated = text.slice(0, maxChars);
	const lastNewline = truncated.lastIndexOf("\n");
	const cutPoint = lastNewline > maxChars * 0.8 ? lastNewline : maxChars;

	return truncated.slice(0, cutPoint) + "\n\n[...content truncated for length]";
}
