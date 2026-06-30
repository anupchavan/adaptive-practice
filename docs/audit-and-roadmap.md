# Adaptive Practice — audit & release roadmap

_Plan of record. Created 2026-06-28 from a full subsystem audit + learning-science research pass against the product goals. Phase 0 is implemented; later phases are proposed._

## Where the plugin is

v0.3.5 is ~60% to a quality release — far more built than the version implies. Genuinely solid: the tolerant JSON parser, SSRF-hardened remote media, the Bases-style frontmatter filter builder, defensive secret storage, theme-compliant CSS, and a structure-aware prompt. The two highest-leverage learning-science ideas (retrieval-first questions + non-random weakness/recency-aware daily selection) already exist. The remaining work is hardening uneven/superficial pieces and fixing a cluster of correctness/scale/consistency issues.

## Goal status (1–13)

| # | Goal | Status | Notes |
|---|------|--------|-------|
| 1 | Frontmatter-aware structure | mostly | Strong; fence-unaware parsing was corrupting CS notes → **fixed (Phase 0)**. |
| 2 | Image/whiteboard understanding | partial | Vision wired (Anthropic/Gemini/OpenAI/OpenRouter); SVG-as-text truncated, no downscale/transcribe-cache, OpenAI PDFs needlessly blocked. |
| 3 | Multi-model consistent quality | weak (P0) | Root cause is mechanical: no strict structured output, prompt sent as user (not system) role, no post-gen LaTeX/markdown validation. Solve provider-side, not by fine-tuning. |
| 4 | Scale to 10k+ notes | weak→improving (P0) | Index split out of data.json done; still need event-driven incremental indexing + picker virtualization + debounced sweeps. |
| 5 | Ignore clipper junk | partial | Denylist only catches known whole-line English phrases; add link/text-density block scoring. |
| 6 | Daily practice / decay / non-repeat | partial (P0) | Selection is good; scheduler is magic-number heuristics (no real forgetting curve), `stabilityDays` never compounds, `practicedSubtopics` recorded but unused. |
| 7 | Skill survives rename/edit | weak→improving (P0) | Skill in frontmatter (good). Rename/delete handlers added → path-keyed state no longer orphaned. contentHash external-move recovery still TODO. |
| 8 | Domain/intent-relative triviality | weak | Static domain block but no domain detection, no user-intent input, a global English recall-blocker regex deletes valid questions. |
| 9 | Flow / just-in-time generation | partial | All questions generated up front; adaptation only reorders a frozen pool. |
| 10 | Smoothness + guideline compliance | partial | Good lifecycle hygiene; write-amplification (improved), 1102-line main.ts, two quiz UIs, picker not virtualized. |
| 11 | Cheap fine-tune / own model | missing (P3) | Don't fine-tune now; BYOK can't reach a dev model. Build a synthetic exemplar dataset opportunistically; only ship as optional local GGUF later. |
| 12 | Reasonable tokens | weak | Fixed 8192 output, parse-retry re-bills, no prompt caching, native-res images re-sent each session. |
| 13 | Research-grounded | partial | Vocabulary-grounded; no FSRS, no interleaving across notes, no groundedness/answerability validator. |

## Decisions taken (2026-06-28)

- **State model:** skill stays in frontmatter; all other state in `data.json` keyed by path; rename/delete event handlers are the primary re-link, contentHash the eventual fallback.
- **Sequencing:** Phase 0 (correctness/data-integrity) first.
- **No synthetic test vault** — test against the real 438-note vault.
- **Consistency = provider-side**, not fine-tuning.

## Roadmap

- **Phase 0 — release blockers (DONE):** see changelog below.
- **Phase 1 — cross-provider consistency (Goal 3):** strict-compatible schema + native structured output per provider; system-role prompt + pinned low temperature; deterministic LaTeX/markdown/KaTeX normalizer-repair; 1–2 few-shot exemplars; an eval harness (built _before_ flipping strict on) measuring per-provider deviation. Add the user-intent field here.
- **Phase 2 — scheduling on real science (Goals 6, 13):** FSRS/DSR core at note level (the plugin already stores S/D/dueAt), per-subtopic (DAS3H) stability driving due-ness off the weakest subtopic (finally consuming `practicedSubtopics`), interleaving across notes within a session, treat `updated > lastPracticed` as a partial stability reset, overlearning cap, streak in the reminder Notice + status bar.
- **Phase 3 — question quality (Goals 8, 13):** user-intent (cram/mastery/review) conditioning; per-domain Depth-of-Knowledge rules + domain detection; groundedness/answerability validator (solver/self-consistency, gated by cost); over-generate-and-rank distractors; LLM student-simulation difficulty (regex as pre-filter only).
- **Phase 4 — scale + polish (Goals 4, 10, 12):** event-driven incremental indexing, debounced sweeps, cached `scanVaultProperties`, virtualized picker, scoped keydown handlers, prompt caching, image downscale + transcribe-cache, scale output tokens to count, retire one quiz UI, slim main.ts.
- **Phase 5 — flow JIT (Goal 9) + optional model ($0 groundwork, Goal 11):** hybrid just-in-time generation with a tiny pre-validated cache; closed control loop holding ~85% rolling accuracy via an accuracy × item-relative-time rule with hysteresis; build a 300–1000 example synthetic dataset (exemplars + validator fixtures + future QLoRA data).

## Phase 0 changelog (implemented)

1. **Vault rename/delete handlers** (`main.ts`, new `path-migration.ts`): renaming/moving a note (or folder) now re-keys all path-keyed state (practice notes, index, pdf skills); delete prunes it. Fixes silent learning-history loss.
2. **Index split out of `data.json`** (new `index-store.ts`): the skeleton index lives in `practice-index.json`, written only on scan/rename/delete; per-answer saves shrink ~30%. One-time migration extracts a legacy inline index automatically (verified live: 416 entries moved, notes/streak preserved).
3. **By-path session stats & skill deltas** (`scheduler.ts`, `grader.ts`): two notes sharing a title no longer corrupt each other's skill.
4. **Fence-aware heading/section parsing** (`normalize.ts`, `reader.ts`): `#` lines inside code blocks are no longer promoted to headings/sections.
5. **MCQ grade-vs-highlight unified** (`practice-view.ts`, `quiz-modal.ts`): the highlighted correct option uses the same normalized equality as grading.
6. **Integer-mislabel grading** (`grader.ts`): a non-integer answer mislabeled `integer` now grades with tolerance instead of always wrong.
7. **Gemini/Anthropic robustness** (`gemini.ts`, `anthropic.ts`): Gemini key moved to `x-goog-api-key` header (no URL leak) and all answer parts concatenated; Anthropic joins all text blocks; both detect output-token truncation and report it clearly.

Verification: `npm run check` green — build, lint, 122 tests (8 new), release validation.

## Phase 1 changelog (in progress — cross-provider consistency)

1. **Provider-agnostic output normalizer** (new `format-normalize.ts`, wired in `parse.ts`): every parsed question is run through deterministic repairs so output is uniform regardless of provider. Converts LaTeX-native delimiters `\(...\)`→`$...$` and `\[...\]`→`$$...$$` (Obsidian renders only the `$` forms), preserving MCQ option↔correctAnswer equality and leaving numeric answers untouched. Includes `detectFormatIssues` as the eval-harness deviation counter.
2. **System-role prompt + pinned temperature** (`prompt.ts` + all 4 clients): `buildPrompt` now returns split `systemPrompt` (stable HOW: contract, difficulty, formatting, schema) and `userPrompt` (per-session material), with `textPrompt` retained as the combined fallback. Anthropic uses the `system` param, Gemini uses `systemInstruction`, OpenAI-compatible/Responses put real instructions in the system/`instructions` slot (was a throwaway one-liner). Temperature pinned to `GENERATION_TEMPERATURE = 0.4` everywhere (was 0.7–1.0, Anthropic unset).
3. **Strict-compatible schema** (`openai-shared.ts`): `questionSchema` fixed to be strict-structured-output valid — all properties in `required`, `options` nullable, no `minItems` (the old shape set `additionalProperties:false` while omitting `options` from `required`, which is invalid).

4. **Link a note only once per question** (`question-calibration.ts` root fix + `format-normalize.ts` safety net): `linkSourceTopicMentions` linked *every* occurrence of a source title; now each distinct note is linked only on its first mention (later mentions stay plain text), threaded via a shared `linkedTargets` set. The normalizer also dedupes model-emitted wiki/markdown links (image embeds untouched). Came from real-vault testing where "version control" was linked twice in one stem.

Verification: `npm run check` green — build, lint, 131 tests, release validation.

## Phase 2 changelog (in progress — scheduling on real learning science)

1. **FSRS-style scheduler core** (`scheduler.ts`): replaced the magic-number `nextIntervalDays` (skill buckets 2/4/8/14d; `stabilityDays` never compounded, so mature notes were re-asked every 1–3 weeks forever) with a Difficulty/Stability/Retrievability model. Power forgetting curve `R(t)=(1+19/81·t/S)^-0.5` (so `R(S)=0.9`); difficulty derived from skill; stability **compounds** on success (spacing effect — bigger gains when the item was overdue/low-R and the note is easy/high-skill) and resets low (≤3d) on a lapse so forgotten notes resurface fast; `dueAt` derived from a target-retention dial (default 0.9). Exported `retrievability`, `intervalForRetention`, `nextStabilityDays`, `DEFAULT_TARGET_RETENTION`. 5 new FSRS unit tests; the existing slow-recall invariant still holds.

Verification: `npm run check` green — build, lint, 136 tests, release validation.

**Phase 2 remaining:** per-subtopic (DAS3H) stability so due-ness keys off the weakest subtopic and `practicedSubtopics` (recorded but unused) finally drives selection; interleave questions across due notes within a session; treat `updated > lastPracticed` as a partial stability reset; cap new/changed-per-day and same-day repeats of mastered items; surface streak in the reminder Notice + a status-bar indicator; expose the target-retention dial in settings.

**Phase 1 remaining (needs live-provider testing):** flip `strict: true` on the OpenAI/OpenRouter json_schema requests and add Gemini `responseSchema`; add 1–2 few-shot exemplars (per-provider toggle); KaTeX compile-validation of math spans (heavier — needs a bundled validator). Defer the strict flip until it can be tested against a real provider, since a rejected strict schema 400s the request with no fallback.

## Known caveats / not-yet-done

- Default model IDs (`claude-sonnet-4-6`, `gemini-3.5-flash`, etc.) are future-dated but **valid in this environment** (the configured Anthropic default works). Audit agents flagged them only because of training-cutoff skepticism. Verify secondary providers' defaults against live model lists before release.
- External moves (done outside Obsidian while it isn't running) still rely on the existing fuzzy title/timestamp carry-forward; a contentHash-based relink is the planned fallback.
