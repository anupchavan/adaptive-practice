import {
	DailyChallengeMode,
	NoteMediaReference,
	NoteStructure,
	PracticeIntent,
	PromptAttachment,
	QuestionFeedbackEntry,
	QuestionFeedbackKind,
	SubtopicPracticeState,
	TopicNote,
} from "../types";
import { extractConceptCandidates, normalizeConceptKey } from "../notes/concepts";
import { desiredDifficultyCounts } from "../practice/flow-calibration";

const MAX_TOTAL_CONTENT_CHARS = 120_000;
const MAX_HISTORY_RATIO = 0.25;
const MAX_OUTLINE_ITEMS = 40;
const MAX_RENDERED_SECTIONS = 16;
const MIN_SECTION_CHARS = 280;
const MAX_SUBTOPIC_MEMORY_ITEMS = 12;
const MAX_CONCEPT_TARGETS = 18;
const MAX_FEEDBACK_EXAMPLES = 4;
const MAX_FEEDBACK_ITEMS = 24;
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
	/** Canonical combined prompt (system + user). Kept for fallback and tests. */
	textPrompt: string;
	/** Stable instructions (role, contract, difficulty, formatting, schema). */
	systemPrompt?: string;
	/** Per-session material (calibration, topics, generation trigger). */
	userPrompt?: string;
	attachments: PromptAttachment[];
}

/**
 * One low temperature across every provider so output style is consistent and
 * not a function of each adapter's historical default (which ranged 0.7–1.0).
 */
export const GENERATION_TEMPERATURE = 0.4;

/** Used when a prompt builder did not supply a dedicated system instruction. */
export const DEFAULT_SYSTEM_INSTRUCTION =
	"You generate Adaptive Practice questions. Return only valid JSON.";

/**
 * Resolve a prompt into its system/user halves, falling back to the combined
 * text when a builder only populated `textPrompt` (e.g. test fixtures).
 */
export function resolvePromptParts(
	prompt: StructuredPrompt
): { system: string; user: string } {
	const system = prompt.systemPrompt?.trim()
		? prompt.systemPrompt
		: DEFAULT_SYSTEM_INSTRUCTION;
	const user = prompt.userPrompt?.trim() ? prompt.userPrompt : prompt.textPrompt;
	return { system, user };
}

export interface PromptBuildOptions {
	challengeMode?: DailyChallengeMode;
	challengeReason?: string;
	questionFeedback?: QuestionFeedbackEntry[];
	intent?: PracticeIntent;
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
	const feedbackGuidance = renderQuestionFeedbackGuidance(
		options.questionFeedback ?? [],
		topics.map((topic) => topic.note)
	);
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

	const systemPrompt = `You are Adaptive Practice, an Obsidian-native practice coach. Your goal is durable learning and transfer, not trivia volume.

## Core learning contract

1. Use retrieval practice: ask the learner to produce, choose, calculate, debug, compare, prove, or transfer an idea.
2. Use desirable difficulty: questions should be effortful but answerable from the notes plus prerequisite reasoning.
3. Use spacing and interleaving: prioritize topics marked due, low-skill, recently changed, or weak in past practice. When multiple topics are present, mix them naturally.
4. Use flow-friendly calibration: aim for a session that a prepared learner can get roughly 70-85% correct. Start with one approachable question only if needed, then move toward deeper transfer.
5. Avoid repeating exact subtopics from past practice unless the learner struggled or the scheduler says the topic is due.
6. Treat a note title as a source label, not automatically as the concept. Use headings, sections, frontmatter, diagrams, examples, and recurring terms to identify the actual concept being tested.
7. Ignore clipped webpage junk, navigation labels, cookie banners, and unrelated boilerplate even if it appears in the note.
8. For notes about named problems, make the question self-contained. Restate the input/goal or concrete setup needed for the reasoning; do not expect the learner to remember a problem statement from the title alone.

Subtopic memory rule: each topic may include structured subtopic memory. Use "revisit" subtopics when they show misses, skips, slow/weak performance, or the topic is due. Avoid "mastered" subtopics unless they are needed as a stepping stone for transfer. Prefer headings or unpracticed sections for fresh questions.

## Difficulty calibration

Difficulty is domain-relative:

**Easy** = one clear reasoning step, direct application, or essential factual retrieval when the subject genuinely rewards facts.

**Medium** = 2-3 connected steps, choosing a method, interpreting a diagram/code/pathway, or spotting a common misconception.

**Hard** = genuinely non-routine transfer to a new setting, edge cases, proof/counterexample, multi-topic synthesis, debugging from symptoms, or a trap a competent learner might miss.

Label a question "hard" only if a prepared learner needs at least two substantial reasoning moves. Do not mark a direct fact lookup, single formula substitution, or one-iteration trace as hard. Hard distractors must be tempting for a real reason, not obviously silly.

Adjust the distribution based on skill level and recent results:
- Skill 0-30: 60% easy, 30% medium, 10% hard
- Skill 31-60: 30% easy, 45% medium, 25% hard
- Skill 61-80: 10% easy, 40% medium, 50% hard
- Skill 81-100: 0% easy, 25% medium, 75% hard

## Depth is domain-relative

Infer each note's field and what mastery means there from its structure, vocabulary, and emphasis, then test the kind of thinking that field rewards. Classify per question, not per note — one note can mix these:

- Procedural material (tools, commands, syntax, notation, protocols, techniques): have the learner construct or debug a solution under constraints, predict outputs or resulting state, pick the right technique for a scenario, or explain why a tempting alternative fails. Never merely ask to name the tool, option, or step.
- Quantitative/formal material (mathematics, physics, engineering, algorithms, logic): have the learner solve, derive, prove or refute, analyze limiting and edge cases, translate between representations, or select and justify a method. Interleave problem types that look similar but require different methods.
- Conceptual/mechanistic material (natural and social sciences, medicine, systems): have the learner explain mechanisms, predict what changes when a variable changes, connect structure to function or property, or say what evidence distinguishes competing explanations.
- Factual/interpretive material (history, law, humanities, arts, language): core facts are fair game when the field genuinely rewards them, but connect them to chronology, causation, comparison, significance, or interpretation whenever the note supports it.

Aim questions at where the note's substance is. If a note opens with a brief introduction and then goes deep, quiz the depth, not the introduction. If the whole note is genuinely introductory, test the definitions and simple applications it actually contains instead of inventing depth it cannot support. Biographical or naming trivia is only valid when the note itself treats it as central.

## Formatting and media

1. Use Obsidian-compatible Markdown.
2. Use LaTeX wrapped in dollar signs: $x^2$ inline and $$\\sum_{i=1}^{n} i$$ for display. Never output bare LaTeX.
3. Use fenced code blocks for code, traces, or pseudo-code when it clarifies the problem.
4. For MCQ, provide exactly 4 plausible options. Draft five or six candidates internally and keep the four most plausible; every distractor must embody a specific, nameable mistake: sign errors, off-by-one errors, wrong formula choice, missing condition, overgeneralization, confusing best/worst/average case, or violating an invariant. Never include an option the stem already rules out.
5. If images, SVG notes, or PDFs are attached or described, inspect and use them. Treat diagrams and whiteboard images as first-class source material.
6. Each question must list exact "sourceTopics" using the topic titles provided in the session material, and "sourceSubtopics" using the concept target, section name, invariant, mechanism, or trap being tested. Do not put the note title in "sourceSubtopics" unless the note has no more specific concept.

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

One exemplar of the signature format — match its formatting discipline (inline code, fenced code, $-wrapped math, reason-paired options, concrete sourceSubtopics), never its topic or phrasing:

{
  "id": "q1",
  "type": "mcq",
  "questionText": "An array of $n$ distinct sorted integers is rotated once.\\n\\n\`\`\`python\\nwhile lo < hi:\\n    mid = (lo + hi) // 2\\n    if arr[mid] > arr[hi]: lo = mid + 1\\n    else: hi = mid\\n\`\`\`\\nWhy does the loop always converge on the minimum?",
  "options": [
    "\`arr[mid] > arr[hi]\` proves the minimum lies right of mid, so discarding the left half preserves the invariant",
    "The midpoint always lands in the sorted half, so the loop scans it linearly",
    "Integer division guarantees \`lo == hi\` after exactly $\\\\log_2 n$ steps for every input",
    "Comparing with \`arr[hi]\` sorts the array first, making plain binary search valid"
  ],
  "correctAnswer": "\`arr[mid] > arr[hi]\` proves the minimum lies right of mid, so discarding the left half preserves the invariant",
  "explanation": "The unsorted half must contain the rotation point, so the invariant keeps the minimum inside [lo, hi] and the range halves each step: $O(\\\\log n)$.",
  "sourceTopics": ["Rotated arrays"],
  "sourceSubtopics": ["loop invariant", "rotation point"],
  "difficulty": "medium"
}`;

	const userPrompt = `Generate exactly ${questionCount} questions from the provided vault material.

## Session calibration

Session mode: ${formatChallengeMode(challengeMode)}
Scheduler reason: ${challengeReason}
${challengeModeInstructions(challengeMode)}
${intentInstructions(options.intent ?? "mastery")}
${renderDifficultyTargetGuidance(topics, questionCount, challengeMode)}
${feedbackGuidance}

## Topics

${allTopicBlocks}

Generate exactly ${questionCount} questions now.`;

	const textPrompt = `${systemPrompt}\n\n${userPrompt}`;

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

	return {
		textPrompt,
		systemPrompt,
		userPrompt,
		attachments: [...pdfAttachments, ...mediaAttachments],
	};
}

function formatChallengeMode(mode: DailyChallengeMode): string {
	if (mode === "warmup") return "warm-up";
	return mode;
}

/**
 * The learner's declared purpose shifts question STYLE, not the difficulty
 * distribution (skill and session mode govern that). Cram legitimizes
 * exam-typical recall; review trades depth for breadth.
 */
function intentInstructions(intent: PracticeIntent): string {
	if (intent === "cram") {
		return [
			"Learner intent: exam cram.",
			"Prioritize high-yield facts, formulas, definitions, named results, and the classic traps of the field. Exam-typical single-concept items are acceptable at their honest difficulty label; keep stems fast to read and answers unambiguous.",
		].join("\n");
	}
	if (intent === "review") {
		return [
			"Learner intent: broad review.",
			"Favor breadth over depth: touch as many distinct subtopics as the question count allows with quick, targeted checks. Reserve deep multi-step constructions for subtopics flagged weak in the memory data.",
		].join("\n");
	}
	return [
		"Learner intent: durable mastery.",
		"Favor understanding and transfer over recognition; recall items must earn their place by centrality.",
	].join("\n");
}

function challengeModeInstructions(mode: DailyChallengeMode): string {
	if (mode === "warmup") {
		return [
			"Calibration rule: this is a warm-up session for fragile recall.",
			"Favor confidence-building retrieval first: use the skill-based target mix below, one concept per question, and simpler setups than a steady session without dropping below the learner's level.",
			"Use mistakes, slow recall, skips, or new-note status as signals to ask diagnostic questions that reveal the misconception without overwhelming the learner.",
		].join("\n");
	}
	if (mode === "stretch") {
		return [
			"Calibration rule: this is a stretch session after strong recent accuracy and fluency.",
			"Favor transfer: mostly medium/hard questions, edge cases, mixed topics, proof/counterexample, diagrams, traces, or the classic traps of the field.",
			"Keep the questions answerable from the notes, but avoid direct copy-paste recall unless a fact is genuinely central.",
		].join("\n");
	}
	return [
		"Calibration rule: this is a steady session.",
		"Use the skill-based difficulty distribution below and sequence questions from approachable recall toward transfer.",
		"Keep challenge close to the learner's current level so the session feels focused rather than either trivial or punishing.",
	].join("\n");
}

function renderDifficultyTargetGuidance(
	topics: TopicContext[],
	questionCount: number,
	mode: DailyChallengeMode
): string {
	const average = averageTopicSkill(topics.map((topic) => topic.note));
	const desired = desiredDifficultyCounts(questionCount, average, mode);
	const highSkillTopics = topics.filter((topic) => topic.note.skill >= 81);
	const lines = [
		"",
		`Target mix for this session: ${desired.easy} easy, ${desired.medium} medium, ${desired.hard} hard.`,
	];

	if (highSkillTopics.length > 0) {
		const allHighSkill = highSkillTopics.length === topics.length;
		const topicNames = highSkillTopics
			.map((topic) => `${topic.note.title} (${Math.round(topic.note.skill)}/100)`)
			.join(", ");
		lines.push(
			allHighSkill
				? "High-skill rule: do not generate easy questions for this session. If a stem can be answered by recalling a single name, definition, formula, option, or label, rewrite it until it requires transfer."
				: `High-skill topic rule: for ${topicNames}, do not generate easy questions. Questions from these topics should be medium/hard only, and most should be hard. If a stem can be answered by recalling a single name, definition, formula, option, or label, rewrite it until it requires transfer.`
		);
		lines.push(
			"For each high-skill topic, spread questions across multiple concrete sourceSubtopics and genuinely different setups instead of making the whole session variations of one trap, scenario, or section."
		);
		lines.push(
			"When a high-skill note teaches procedures, tools, notation, or methods, hard questions must require doing: construct or debug a solution under constraints, predict the output or resulting state, or explain why a tempting alternative fails. If such a question is MCQ, each option should pair the choice with its reasoning or trap, so the answer tests why it works rather than which name looks right."
		);
		if (highSkillTopics.some((topic) => topic.note.skill >= 90)) {
			lines.push(
				"For topics at skill 90+, a hard question must combine at least two reasoning moves, such as constructing or debugging under constraints plus predicting the resulting output/state, or solving plus explaining why a plausible alternative fails."
			);
		}
	}

	return lines.join("\n");
}

function averageTopicSkill(topics: TopicNote[]): number {
	if (topics.length === 0) return 50;
	return topics.reduce((sum, topic) => sum + topic.skill, 0) / topics.length;
}

function renderQuestionFeedbackGuidance(
	feedback: QuestionFeedbackEntry[],
	topics: TopicNote[]
): string {
	const topicTitles = new Set(topics.map((topic) => topic.title));
	const aliases = new Set(topics.flatMap((topic) => topic.aliases ?? []));
	const relevant = feedback
		.filter((entry) => entry.sourceTopics.some((topic) =>
			topicTitles.has(topic) || aliases.has(topic)
		))
		.sort((a, b) => b.createdAt - a.createdAt)
		.slice(0, MAX_FEEDBACK_ITEMS);
	if (relevant.length === 0) return "";

	const grouped = groupFeedback(relevant);
	const lines = [
		"",
		"## Learner quality feedback",
		"",
		"Use these recent learner flags as calibration data only. Do not quote them as source material.",
	];
	for (const kind of ["too_easy", "too_hard", "bad_concept"] as QuestionFeedbackKind[]) {
		const entries = grouped[kind];
		if (entries.length === 0) continue;
		lines.push(`- ${feedbackLabel(kind)} (${entries.length}): ${feedbackGuidance(kind, entries)}`);
	}

	const examples = relevant
		.slice(0, MAX_FEEDBACK_EXAMPLES)
		.map((entry) =>
			`- ${feedbackLabel(entry.kind)} ${entry.difficulty}: ${truncateText(singleLine(entry.questionText), 160)}`
		);
	if (examples.length > 0) {
		lines.push("Recent flagged stems:");
		lines.push(...examples);
	}
	return lines.join("\n");
}

function groupFeedback(
	feedback: QuestionFeedbackEntry[]
): Record<QuestionFeedbackKind, QuestionFeedbackEntry[]> {
	return {
		too_easy: feedback.filter((entry) => entry.kind === "too_easy"),
		too_hard: feedback.filter((entry) => entry.kind === "too_hard"),
		bad_concept: feedback.filter((entry) => entry.kind === "bad_concept"),
	};
}

function feedbackGuidance(
	kind: QuestionFeedbackKind,
	entries: QuestionFeedbackEntry[]
): string {
	const subtopics = mostCommon(entries.flatMap((entry) => entry.sourceSubtopics), 3);
	const difficulties = mostCommon(entries.map((entry) => entry.difficulty), 3);
	const scope = subtopics.length > 0
		? `Often around ${subtopics.join(", ")}. `
		: "";
	const difficultyNote = difficulties.length > 0
		? `Prior labels: ${difficulties.join(", ")}. `
		: "";
	if (kind === "too_easy") {
		return `${scope}${difficultyNote}Increase depth for similar concepts: require transfer, edge cases, multi-step tracing, or stronger distractors.`;
	}
	if (kind === "too_hard") {
		return `${scope}${difficultyNote}Add scaffolding and avoid stacking unrelated traps; keep the question answerable from the provided notes.`;
	}
	return `${scope}${difficultyNote}Avoid note-title recall and source-label questions; test the underlying concept named by headings, examples, mechanisms, invariants, or traps.`;
}

function feedbackLabel(kind: QuestionFeedbackKind): string {
	if (kind === "too_easy") return "Too easy";
	if (kind === "too_hard") return "Too hard";
	return "Bad concept";
}

function mostCommon(values: string[], limit: number): string[] {
	const counts = new Map<string, number>();
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, limit)
		.map(([value]) => value);
}

function singleLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
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
		const outlineLimit = Math.max(
			6,
			Math.min(MAX_OUTLINE_ITEMS, Math.floor(contentBudget / 180) || 6)
		);
		const outlineHeadings = structure.headings.filter(
			(heading) => !isLowValueHeading(heading.heading, structure.title)
		);
		if (outlineHeadings.length > 0) {
			const outline = outlineHeadings
				.slice(0, outlineLimit)
				.map((heading) => `${"  ".repeat(Math.max(0, heading.level - 1))}- ${heading.heading}`)
				.join("\n");
			const omitted = outlineHeadings.length - outlineLimit;
			const omittedLine = omitted > 0
				? `\n[...${omitted} additional outline items omitted]`
				: "";
			parts.push(`<outline>\n${outline}${omittedLine}\n</outline>`);
		}
	}
	const concepts = renderConceptTargets(topic, contentBudget);
	if (concepts) parts.push(concepts);
	if (structure.media.length > 0) {
		parts.push(renderMedia(structure.media));
	}

	parts.push(renderSections(topic, contentBudget, now));
	return parts.join("\n");
}

function renderConceptTargets(topic: TopicContext, contentBudget: number): string {
	const structure = topic.structure!;
	const conceptLimit = Math.max(
		4,
		Math.min(MAX_CONCEPT_TARGETS, Math.floor(contentBudget / 140) || 4)
	);
	const highSkill = topic.note.skill >= 75;
	const unique = uniqueConcepts(extractConceptCandidates(structure, conceptLimit * 8))
		.map((concept, index) => ({
			concept,
			index,
			score: conceptTargetPriority(concept, topic, highSkill),
		}))
		.filter(({ score }) => score > Number.NEGATIVE_INFINITY)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map(({ concept }) => concept)
		.slice(0, conceptLimit);
	if (unique.length === 0) return "";
	return `<concept_targets>\n${unique.map((concept) => `- ${concept}`).join("\n")}\n</concept_targets>`;
}

function conceptTargetPriority(
	concept: string,
	topic: TopicContext,
	highSkill: boolean
): number {
	const key = normalizeConceptKey(concept);
	if (!key || key === normalizeConceptKey(topic.structure!.title)) {
		return Number.NEGATIVE_INFINITY;
	}
	if (isLowValueHeading(concept, topic.structure!.title)) {
		return Number.NEGATIVE_INFINITY;
	}
	let score = 0;
	if (hasReasoningCue(key)) score += highSkill ? 4 : 3;
	if (key.split(" ").length >= 2) score += 0.5;
	return score;
}

/**
 * Concept/section names that promise reasoning depth rather than enumeration,
 * in any field: failure modes, tradeoffs, mechanisms, proofs, exceptions.
 */
function hasReasoningCue(normalizedText: string): boolean {
	return /\b(invariant|edge case|corner case|failure|failure mode|trap|pitfall|gotcha|misconception|complexity|tradeoff|trade off|proof|derivation|mechanism|exception|limitation|caveat|comparison|versus|debug|why|analysis|interaction)\b/.test(
		normalizedText
	);
}

function renderSections(topic: TopicContext, contentBudget: number, now: number): string {
	const structure = topic.structure!;
	const sectionLimit = Math.max(
		1,
		Math.min(
			MAX_RENDERED_SECTIONS,
			Math.floor(contentBudget / MIN_SECTION_CHARS) || 1
		)
	);
	const selected = selectSectionsForPrompt(topic, now, sectionLimit);
	const sectionBudget = Math.max(
		1,
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
	now: number,
	maxRenderedSections = MAX_RENDERED_SECTIONS
): NoteStructure["sections"] {
	const sections = topic.structure?.sections ?? [];
	if (sections.length <= maxRenderedSections) {
		const substantive = sections.filter((section) =>
			isSubstantivePromptSection(section, topic)
		);
		return substantive.length > 0 ? substantive : sections;
	}

	const selected = new Map<number, NoteStructure["sections"][number]>();
	const add = (index: number): void => {
		const section = sections[index];
		if (section && (selected.has(index) || selected.size < maxRenderedSections)) {
			selected.set(index, section);
		}
	};

	const substantive = sections
		.map((section, index) => ({ section, index }))
		.filter(({ section }) => isSubstantivePromptSection(section, topic));
	const selectable = substantive.length > 0
		? substantive
		: sections
			.map((section, index) => ({ section, index }))
			.filter(({ section }) => section.wordCount > 0);
	const highSkill = topic.note.skill >= 75;
	const challengeSelectable = highSkill
		? selectable.filter(({ section }) => hardChallengeSectionPriority(section, topic) > 0)
		: [];

	if (!highSkill && selectable.length > 0) {
		add(selectable[0]!.index);
	}

	const prioritySlots = Math.max(
		1,
		Math.floor(maxRenderedSections * (highSkill ? 1 : 1 / 3))
	);
	const prioritizedSource =
		highSkill && challengeSelectable.length > 0
			? challengeSelectable
			: selectable;
	const prioritized = prioritizedSource
		.map(({ section, index }) => ({
			index,
			score: sectionPromptPriority(section, topic, now),
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index);
	for (const { index } of prioritized) {
		if (selected.size >= prioritySlots + (highSkill ? 0 : 2)) break;
		add(index);
	}

	const slots = Math.max(1, maxRenderedSections - selected.size);
	const denominator = Math.max(1, slots - 1);
	const spacingSource =
		highSkill && challengeSelectable.length > 0
			? challengeSelectable
			: selectable;
	for (let i = 0; i < slots; i++) {
		const source = spacingSource.length > 0
			? spacingSource
			: sections.map((section, index) => ({ section, index }));
		const sourceIndex = Math.round((i * (source.length - 1)) / denominator);
		add(source[sourceIndex]!.index);
	}

	const fillSource =
		highSkill && challengeSelectable.length > 0
			? [...challengeSelectable, ...selectable]
			: selectable;
	for (const { index } of fillSource) {
		if (selected.size >= maxRenderedSections) break;
		add(index);
	}

	for (let i = 0; selected.size < maxRenderedSections && i < sections.length; i++) {
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
	if (isLowValueSection(section, topic)) return 0;
	const heading = normalizeHeading(section.heading);
	if (!heading) return 0.25;
	const challengeScore = hardChallengeSectionPriority(section, topic);

	const practiced = topic.practicedSubtopics ?? {};
	const practicedEntries = Object.entries(practiced);
	const matching = practicedEntries
		.filter(([name]) => headingsOverlap(heading, normalizeHeading(name)))
		.map(([, state]) => subtopicMemoryScore(state, now));
	if (matching.length > 0) {
		return 6 + Math.max(...matching) + challengeScore;
	}

	const isUnpracticed = !practicedEntries.some(([name]) =>
		headingsOverlap(heading, normalizeHeading(name))
	);
	return (isUnpracticed ? 1 : 0) + challengeScore;
}

function isSubstantivePromptSection(
	section: NoteStructure["sections"][number],
	topic: TopicContext
): boolean {
	return section.wordCount > 0 && !isLowValueSection(section, topic);
}

function isLowValueSection(
	section: NoteStructure["sections"][number],
	topic: TopicContext
): boolean {
	if (isLowValueHeading(section.heading, topic.structure?.title ?? topic.note.title)) {
		return true;
	}
	const contentKey = normalizeHeading(section.content);
	if (!contentKey) return false;
	if (section.wordCount <= 10 && /\b(cc by nc sa|copyright|creative common|license|agenda)\b/.test(contentKey)) {
		return true;
	}
	return false;
}

function isLowValueHeading(heading: string, noteTitle: string): boolean {
	const key = normalizeHeading(heading);
	if (!key) return false;
	if (key === normalizeHeading(noteTitle)) return true;
	return /^(body|license|agenda|table of contents|contents|references|bibliography|q a|q and a|questions|thank you|appendix)$/.test(key);
}

/**
 * How promising a section is as hard-question material for a high-skill
 * learner, judged from domain-neutral depth signals: reasoning-cue language,
 * worked/applied detail, and formal notation (code, math, tables) in the raw
 * content. Enumerative name-and-purpose sections naturally score ~0.
 */
function hardChallengeSectionPriority(
	section: NoteStructure["sections"][number],
	topic: TopicContext
): number {
	if (topic.note.skill < 75) return 0;
	const raw = section.content.slice(0, 2000);
	const text = normalizeHeading(`${section.heading} ${raw}`);
	let score = 0;
	if (hasReasoningCue(text)) score += 2;
	if (/\b(edge case|trap|failure|debug|symptom|invariant|why|compare|construct|derive|counterexample)\b/.test(text)) score += 1.5;
	if (/\b(example|worked|walkthrough|application|apply|analysis|case study|derivation|step by step)\b/.test(text)) score += 0.8;
	// Causal/mechanism prose separates explanation from bare enumeration.
	if (/\b(because|so that|prevents?|instead of|rather than|otherwise|whereas|which means|allows?|causes?|depends on|affects?)\b/.test(text)) score += 0.8;
	if (/```|~~~|\$[^$\n]+\$|\n\s*\|.+\|/.test(raw) || /`[^`\n]+`/.test(raw)) score += 1.2;
	return Math.min(5, score);
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
		const key = normalizeConceptKey(trimmed);
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
