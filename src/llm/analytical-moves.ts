import { Question } from "../types";
import { StructuredPrompt } from "./prompt";

/**
 * The analytical-moves engine.
 *
 * A great question is not a fact wrapped in four options; it is a *move* — a
 * reusable reasoning maneuver that forces application over recall. The moves
 * below are the recurring shapes behind hard questions in strong problem books
 * (physics olympiad sets, algorithm interviews, medical vignettes, case law):
 * they are deliberately DOMAIN-GENERAL. "Approximation breakdown" is the same
 * maneuver whether the idealization is a point charge, an O(1) hash lookup, or
 * ideal enzyme kinetics. Naming the moves and handing the model the catalog
 * turns "write a hard question" (which regresses to competent-but-flat) into
 * "instantiate this specific maneuver on this material".
 *
 * This is the quality core. It is a single module on purpose, so it can move
 * behind a server later without touching the rest of the plugin.
 */

export interface AnalyticalMove {
	key: string;
	name: string;
	/** What in the material makes this move available. */
	trigger: string;
	/** The general shape of a question built on the move — no domain baked in. */
	shape: string;
}

export const ANALYTICAL_MOVES: AnalyticalMove[] = [
	{
		key: "approximation-breakdown",
		name: "Approximation breakdown",
		trigger: "the material teaches a model, formula, or rule that holds under stated (often unstated) assumptions",
		shape: "Put the learner in the regime where a reflexively-applied idealization stops holding, and ask what actually changes and why.",
	},
	{
		key: "false-symmetry",
		name: "False symmetry",
		trigger: "two cases, views, or methods look interchangeable on the surface",
		shape: "Present the apparent equivalence, invoke a principle that seems to confirm it, and force the level at which the two genuinely diverge.",
	},
	{
		key: "minimal-pair",
		name: "Minimal pair",
		trigger: "two setups differing in a single feature lead to different outcomes",
		shape: "Present both cases side by side, identical except for one feature, and ask why the outcomes diverge — the lone difference isolates the concept doing the real work.",
	},
	{
		key: "modal-filter",
		name: "Necessary vs. possible",
		trigger: "several conclusions are plausible but only some are forced by the premises",
		shape: "Ask what can be concluded with certainty (or what MUST vs. merely CAN happen), so plausible-but-unforced options fail.",
	},
	{
		key: "limiting-case",
		name: "Limiting case",
		trigger: "a quantity, count, or parameter can be pushed toward zero, one, infinity, or a boundary",
		shape: "Drive a parameter to an extreme and ask for the resulting behavior — or use an extreme to eliminate answers that break there.",
	},
	{
		key: "counterexample-hunt",
		name: "Counterexample hunt",
		trigger: "the material states a general claim, rule, or invariant",
		shape: "Ask whether the claim always holds; if not, require the minimal case that breaks it or the exact range of inputs where it fails — never a hand-wave that it 'sometimes' fails.",
	},
	{
		key: "consistency-check",
		name: "Consistency / dimensional check",
		trigger: "answers carry units, types, sizes, or structural shape that must agree",
		shape: "Offer candidates that are wrong on units, type, dimensionality, or shape, answerable by a consistency check before any calculation.",
	},
	{
		key: "invariant-under-change",
		name: "Invariant under transformation",
		trigger: "the setup can be re-framed, reordered, relabeled, or viewed from another reference",
		shape: "Change the frame/order/representation and ask what is preserved and what is not — separating the essential from the incidental.",
	},
	{
		key: "faithful-translation",
		name: "Faithful translation",
		trigger: "the same content exists in two representations (source and target language, formula and code, spec and implementation, notation and meaning)",
		shape: "Ask for the faithful counterpart in the other representation — or plant one subtle infidelity (wrong scale, dropped sign, reordered effect) among near-miss translations and ask which preserves the meaning.",
	},
	{
		key: "resource-minimality",
		name: "Resource minimality",
		trigger: "a task can be done with more or fewer units of a bounded resource (steps, operations, memory, queries, assumptions)",
		shape: "Ask for the minimum of the resource that still works, or whether a proposed floor is achievable — with distractors that are correct-but-wasteful or infeasibly tight.",
	},
	{
		key: "capacity-limit",
		name: "Capacity limit",
		trigger: "a representation, container, or channel has a fixed budget (bits, digits, range, precision, slots)",
		shape: "Ask what exactly fits, what happens one step past the limit, or which workaround the system needs once the value exceeds the field.",
	},
	{
		key: "edge-case",
		name: "Boundary / edge case",
		trigger: "a procedure or rule has a general path plus seams (empty, single, duplicate, maximum, tie, degenerate input)",
		shape: "Aim the question at the seam where the general rule needs special handling, and ask what happens or what breaks there.",
	},
	{
		key: "necessary-sufficient",
		name: "Necessary vs. sufficient",
		trigger: "a condition, feature, or step is involved in producing an outcome",
		shape: "Ask whether the condition is necessary, sufficient, both, or neither — with distractors for each of the other three verdicts.",
	},
	{
		key: "causal-direction",
		name: "Causal direction / confound",
		trigger: "two factors co-occur or one appears to drive another",
		shape: "Ask which way the causation runs, or what third factor explains both — distinguishing correlation from mechanism.",
	},
	{
		key: "ordering-dependence",
		name: "Order / sequencing dependence",
		trigger: "multiple operations, steps, or events could occur in different orders",
		shape: "Ask whether the outcome depends on order — whether the steps commute — and where a reordering silently changes the result.",
	},
	{
		key: "constrained-tradeoff",
		name: "Constrained trade-off",
		trigger: "improving one property costs another, and the material implies a choice",
		shape: "State a concrete constraint and ask which option is right GIVEN it — never which is 'better' in the abstract.",
	},
	{
		key: "double-edge",
		name: "Double edge",
		trigger: "a single design change, intervention, or parameter shift plausibly helps through one mechanism and hurts through another",
		shape: "Ask for both edges of one change — the mechanism by which it improves things AND the mechanism by which the same change degrades them — or for the condition that decides which edge dominates.",
	},
	{
		key: "hidden-assumption",
		name: "Hidden assumption",
		trigger: "an argument, proof, or procedure quietly relies on an unstated premise",
		shape: "Present reasoning that works only if an unstated premise holds; ask the learner to name the premise or the input that voids it.",
	},
	{
		key: "symptom-to-cause",
		name: "Symptom to cause",
		trigger: "the material describes mechanisms whose failure produces observable effects",
		shape: "Give an observed anomaly or failure and ask which mechanism produces exactly that symptom (and not the near-miss ones).",
	},
	{
		key: "flawed-argument",
		name: "Flawed argument",
		trigger: "the material supports a worked solution, derivation, proof, or chain of reasoning",
		shape: "Present a plausible worked attempt containing one specific wrong step, and ask the learner to locate or characterize the flaw — not merely notice the conclusion is wrong.",
	},
	{
		key: "instrument-vs-truth",
		name: "Instrument vs reality",
		trigger: "a quantity is known only through a recording, reading, or observation process that distorts it systematically (delay, relative reference, sampling, bias)",
		shape: "Ask what the instrument will record given the reality, or recover the reality from the recording — with distractors that quietly equate the two.",
	},
	{
		key: "bounds-propagation",
		name: "Tight bounds",
		trigger: "inputs are known only within ranges, or a constraint caps a rate, size, or duration",
		shape: "Ask for the tightest range or extreme value of the outcome consistent with the data — the strongest claim the information licenses; distractors are falsely precise points or looser-than-needed bounds.",
	},
	{
		key: "conservation-accounting",
		name: "Conservation / accounting",
		trigger: "some quantity is conserved, bounded, or must balance across a process",
		shape: "Use the conserved/balancing quantity to constrain the answer, so options that violate the balance are eliminable by accounting.",
	},
	{
		key: "regime-shift",
		name: "Scale / regime shift",
		trigger: "behavior changes qualitatively across scales or regimes (small vs. large, linear vs. nonlinear, sparse vs. dense)",
		shape: "Ask how the behavior or right choice changes when the scale or regime crosses the threshold where the character flips.",
	},
];

/**
 * Render the moves as a compact prompt block. Lives in the SYSTEM prompt (which
 * this plugin marks as a cache breakpoint), so across the micro-batches of a
 * session the catalog is paid for once and then read at cache price — the moves
 * are essentially free at runtime after the first call.
 */
export function renderAnalyticalMovesGuidance(): string {
	const lines = ANALYTICAL_MOVES.map(
		(move) => `- ${move.name} — when ${move.trigger}: ${move.shape}`
	);
	return `## Analytical moves (for medium and hard questions)

A strong question forces the learner to APPLY an idea, not recall it. The maneuvers below are the reusable shapes behind that; they are domain-general — the same move fits mathematics, code, biology, law, history, or design, because each keys off a structural feature of the material, not a topic. When you write a medium or hard question, first pick the move the material genuinely supports, then instantiate it concretely on this note's content.

${lines.join("\n")}

Rules for using the moves:
- Choose per question from what the material actually supports; never force a move a note cannot sustain, and never name the move in the question.
- Weight by material kind: procedural and formal notes most reward faithful translation, resource minimality, capacity limits, tight bounds, boundary cases, and flawed arguments; conceptual and mechanistic notes most reward false symmetry, minimal pairs, causal direction, double edge, instrument-vs-reality, and necessary-vs-possible; factual and interpretive notes mostly earn necessary-vs-possible and comparison-shaped moves.
- Put the learner at risk of the error — never narrate it. A stem may present a claim, derivation, or approach, but must not disclose whether it is correct: "why is this claim wrong?" and "explain why X fails" give the verdict away and reduce the move to recall. Ask what follows, what happens, or which conclusion holds, with wrongness live among the options. The "someone argues X" frame is worn out — at most one question per session may use it, and even then the stem must not reveal whether the person is right.
- A hard question must leave at least two options standing after a first honest pass: build them as conclusions of two complete, plausible reasoning chains that diverge at exactly one step (same claim with the direction, boundary, or quantifier flipped is the classic form). If two options can be discarded by tone, extremity, or obvious silliness without touching the mechanism, the question is medium at best — fix the options or relabel.
- Vary the moves across a session instead of repeating one; different subtopics usually reward different moves.
- One concept gets one scenario per session: re-dressing the same reasoning in new names, numbers, or places is a repeat, not a new question. A second question on the same concept must probe a different aspect through a different move.
- The move sets the reasoning; keep the stem terse and the options homogeneous, exactly as required above. Cutting a narrated persona ("a learner argues...") usually shortens the stem by a third — prefer the bare situation.
- Easy questions do not use these — keep those to one clean step.`;
}

export interface DeepAuthoringPlan {
	prompt: StructuredPrompt;
	/** Questions sent for sharpening, in rendered order (minted ids s1..sn). */
	targets: Question[];
}

export function sharpenId(index: number): string {
	return `s${index + 1}`;
}

/** Parse a minted sharpen id back to its target index; null for foreign ids. */
export function sharpenIndex(id: string): number | null {
	const match = /^s([1-9]\d*)$/.exec(id.trim());
	return match ? Number(match[1]) - 1 : null;
}

/**
 * Deep-authoring "sharpen" pass (opt-in, token-heavy). Takes the hard/medium
 * questions from a finished batch and runs one adversarial rewrite: the model
 * attacks its own questions (shortcut that skips the reasoning? trap that isn't
 * actually a trap? an option that gives the answer away? claimed certainty that
 * doesn't hold?) and returns sharpened replacements. This is the paid-tier
 * quality lever — quality genuinely costs compute — so it is off by default.
 * Returns null when there is nothing worth sharpening.
 */
export function buildDeepAuthoringPrompt(
	basePrompt: StructuredPrompt,
	questions: Question[]
): DeepAuthoringPlan | null {
	const targets = questions.filter(
		(question) => question.difficulty === "hard" || question.difficulty === "medium"
	);
	if (targets.length === 0) return null;

	// The round-trip gets minted ids: merged batches can carry duplicate
	// model-assigned ids ("q1" from two merged responses), so replacement must
	// not key off them. Fields are rendered in schema order (explanation before
	// correctAnswer) to keep modeling the reason-then-answer contract.
	const rendered = targets
		.map((question, index) =>
			JSON.stringify({
				id: sharpenId(index),
				type: question.type,
				questionText: question.questionText,
				options: question.options ?? null,
				explanation: question.explanation,
				correctAnswer: question.correctAnswer,
				correctAnswers: question.correctAnswers ?? null,
				sourceTopics: question.sourceTopics,
				sourceSubtopics: question.sourceSubtopics,
				difficulty: question.difficulty,
			})
		)
		.join("\n");

	const count = targets.length;
	const plural = count === 1 ? "" : "s";
	const correction = `

## Deep authoring pass

Ignore earlier count instructions. Below are ${count} question${plural} you already wrote, one JSON object per line. Act as a hostile expert reviewer and make each one sharper, then re-emit all ${count} in the standard JSON schema.

${rendered}

For every question, attack it and then fix what the attack finds:
1. Shortcut: can a test-wise learner reach the answer WITHOUT the intended reasoning — elimination, longest/most-qualified option, pattern-matching the phrasing, or a stem that already discloses the verdict ("why is this wrong")? If so, rewrite so the reasoning is unavoidable and the verdict stays at stake.
2. Trap integrity: is the intended misconception actually tempting and actually wrong? If the trap is toothless, replace it with one a competent learner would genuinely fall for.
3. Answer soundness: re-derive the answer from the stem alone; if any stated fact contradicts it, or "certainly/must" does not truly hold, fix the answer or the wording.
4. Distractor parity: every option same form, depth, and length (±25%); no giveaways from wording. Rewrite offenders.
5. Economy: cut every word that does not change the answer. Keep the stem terse and, where it fits, deepen the move already in play (approximation breakdown, false symmetry, necessary-vs-possible, limiting case, and the others).

Keep each question answerable from the provided material. Do not invent links. Keep each question's "id" EXACTLY as given ("s1", "s2", ...) so every rewrite replaces its original, and keep "type" and "difficulty" unchanged — sharpen the substance, not the classification. Return only the JSON for the ${count} sharpened question${plural}.`;

	return {
		prompt: {
			...basePrompt,
			userPrompt: `${basePrompt.userPrompt ?? basePrompt.textPrompt}${correction}`,
			textPrompt: `${basePrompt.textPrompt}${correction}`,
		},
		targets,
	};
}
