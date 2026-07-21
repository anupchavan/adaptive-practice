import { generateSessionWithEngine, EngineSession } from "./engine-bridge";
import { App } from "obsidian";
import type {
	AdaptivePracticeSettings,
	LlmProvider,
	QuizResult,
	SessionConfig,
	SkillDelta,
	TopicNote,
} from "../types";
import { updateSkill } from "../notes/writer";
import { computeSkillDeltas } from "./grader";
import { prepareGeneratedQuestionsForSession } from "./flow-calibration";

const ENGINE_PROVIDERS: LlmProvider[] = [
	"anthropic",
	"gemini",
	"openai",
	"ollama",
	"claude-code",
	"codex",
];

/**
 * Generation runs exclusively through the Whetstone native engine - the
 * open-source Rust pipeline the desktop apps ship (seeded authoring,
 * machine verification, blind probes, clarity gating, Elo calibration).
 * The engine binary is auto-downloaded on first use; see engine-bridge.
 */
export async function generateQuestionSession(
	app: App,
	apiKey: string,
	config: SessionConfig,
	provider: LlmProvider,
	settings: AdaptivePracticeSettings
): Promise<EngineSession> {
	if (!ENGINE_PROVIDERS.includes(provider)) {
		throw new Error(
			`${provider} cannot generate questions: pick Anthropic, Gemini, OpenAI, Ollama, Claude Code, or Codex in settings.`
		);
	}
	// PDF topics ride through natively; the engine itself refuses with a
	// clear message when the selected provider cannot read documents.
	const session = await generateSessionWithEngine(app, apiKey, config, provider, settings);
	return {
		...session,
		first: prepareGeneratedQuestionsForSession(session.first, config),
	};
}

export async function finalizeSession(
	app: App,
	topics: TopicNote[],
	results: QuizResult[],
	savePdfSkill?: (path: string, skill: number) => Promise<void>
): Promise<SkillDelta[]> {
	const deltas = computeSkillDeltas(topics, results);

	for (const delta of deltas) {
		await updateSkill(app, delta.path, delta.after, savePdfSkill);
	}

	return deltas;
}

