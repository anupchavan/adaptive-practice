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

All phases implemented as of 2026-07-04 (one commit per phase on `main`). Remaining known gaps are listed under "Known caveats" below.

- **Phase 0 — release blockers (DONE).**
- **Phase 1 — cross-provider consistency (DONE):** strict structured output everywhere (strict:true json_schema on chat + Responses API, Gemini responseSchema) with a one-shot fallback to plain JSON on schema rejection; system-role prompt + pinned temperature; format normalizer incl. math-brace repair; one format exemplar in the system prompt. NOT done: live-provider eval harness (needs API spend) — the auto-fallback de-risked the strict flip in its place.
- **Phase 2 — scheduling on real science (DONE):** FSRS/DSR core; per-subtopic (DAS3H-style) stability with weakest-subtopic selection boost; interleaving across notes in a session; edit-triggered partial stability reset; new-note throttle once reviews exist; streak in Notice + status bar; target-retention dial.
- **Phase 3 — question quality (DONE):** Phase 3a domain de-specialization (see changelog); practice-intent (mastery/cram/review) conditioning; answer-leak + near-duplicate-option rejection; over-generate-and-rank distractor rule. Deferred by token cost: LLM student-simulation difficulty (the deterministic estimator is the pre-filter).
- **Phase 4 — scale + polish (DONE, part deferred):** event-driven debounced incremental index refresh; Anthropic prompt-cache breakpoint on the system prompt; output tokens scaled to question count; active-view-scoped keyboard shortcuts; cached vault property scan; orphaned quiz-modal deleted. Deferred: image downscale + transcribe-cache, picker virtualization, main.ts extraction.
- **Phase 5 — flow JIT + dataset groundwork (DONE):** `flow-engine.ts` — sessions >4 questions generate in micro-batches (3/3/2-style plan); a rolling controller with hysteresis holds success near the ~80–85% band by nudging effective skill per batch; continuation prompts carry asked stems; the practice view keeps a background buffer and degrades gracefully (session ends at generated questions on failure; toggle restores single-shot). "Export practice dataset" command writes feedback + note-state JSONL for a future local judge model.

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

2. **Edit-triggered partial stability reset** (`scheduler.ts` reconcile): a note edited after its last practice now halves `stabilityDays` (floored at 0.5d) in addition to being pulled due — new content means partially invalidated memory, but a minor edit recovers fast because stability compounds again from half. Fires exactly once per observed edit (guarded by the persisted `updatedAt` transition).
3. **Target-retention dial** (`types.ts`, `settings.ts`, `main.ts`, `scheduler.ts`): "Review intensity" dropdown (80/85/90/95% recall, default 90%) threads `settings.targetRetention` into `intervalForRetention` when sessions are recorded; clamped 0.7–0.97 on load.
4. **Streak surfaced** (`main.ts`): the daily reminder Notice now leads with the 🔥 streak, and a clickable status-bar item shows `Practice 🔥 Nd · M due` (hidden when daily practice is off; click opens the dashboard; refreshed with every dashboard render).

**Phase 2 remaining:** per-subtopic (DAS3H) stability so due-ness keys off the weakest subtopic and `practicedSubtopics` drives selection (it already drives prompt guidance + section priority); interleave questions across due notes within a session; cap new/changed-per-day and same-day repeats of mastered items.

## Phase 3a changelog (done — domain de-specialization, Goal 8)

The calibration layer had been overfitted to the test vault: a hardcoded Linux demotion pass (`calibrateHighSkillLinuxDifficulty` keyed to this vault's literal section headings), ~200 lines of shell-specific detectors in `difficulty-quality.ts`, a "Linux shell mechanic diversity" subsystem in `flow-calibration.ts`, hardcoded "Linux/Shell/CLI" alias lists in `source-map.ts`, vault heading blocklists in `prompt.ts`, and Linux/JEE-specific prompt text. All replaced with domain-general mechanisms that preserve the behavioral intent:

1. **Prompt**: enumerated subject rules → an epistemic-family "Depth is domain-relative" block (procedural / quantitative-formal / conceptual-mechanistic / factual-interpretive) with per-question classification, "aim at where the note's substance is", and introductory-note humility. High-skill guidance is now stated in terms of *doing* (construct/debug/predict/explain-why-a-tempting-alternative-fails) with reason-paired MCQ options; the 90+ two-reasoning-moves rule applies to every domain. "JEE-style traps" → "classic traps of the field".
2. **Difficulty estimation** (`difficulty-quality.ts`): shell detectors → domain-neutral procedural analysis. "Technical surface" is measured from notation itself (inline code, fences, math spans, flags/pipes/calls/operators), so shell, SQL, git, spreadsheet formulas, and lab notation all register. Shallow patterns are generalized: name-the-tool recall, token-difference recall (`ls` vs `ls -a`, `kill` vs `kill -9` — with an exemption when the same tokens are *reordered*, which is genuine order-sensitivity reasoning), tool-choice-only MCQs, bare-token option-spotting (capped at medium only when the scenario carries analytical weight), single-step prediction. `isDeepShellHardQuestion` → `isDeepHardQuestion` with a procedural path *and* a conceptual path (≥3 substantial moves), so 90+ verification works for proofs and mechanisms, not just pipelines.
3. **Flow calibration**: the shell-mechanic diversity subsystem → near-duplicate *setup clustering* (token-set Jaccard ≥ 0.6 over stem+options): a batch that re-skins one scenario N times is rejected in any domain, which is strictly more general than the seven hardcoded shell buckets. Verified-hard applies to all topics at skill ≥ 90.
4. **Source reconciliation**: hardcoded domain alias lists → token-containment similarity ("Linux" → "Linux Commands", "Sorting" → "Sorting Algorithms") plus the note's own frontmatter aliases as the intended mechanism for loose labels.
5. **Section/concept selection for high-skill prompts**: vault-heading blocklist → depth signals readable in any note (reasoning-cue language, worked-example/application cues, causal-connective prose, code/math/table density).
6. Tests updated in kind: fixtures got deterministic variant selection (trailing-digit `pickVariant`), Linux-specific message/API assertions moved to the generalized equivalents, and the test that pinned vault-specific section winners now asserts general invariants (boilerplate excluded, structure-aware spread with technical substance, outline present).

**Phase 1 remaining (needs live-provider testing):** flip `strict: true` on the OpenAI/OpenRouter json_schema requests and add Gemini `responseSchema`; add 1–2 few-shot exemplars (per-provider toggle); KaTeX compile-validation of math spans (heavier — needs a bundled validator). Defer the strict flip until it can be tested against a real provider, since a rejected strict schema 400s the request with no fallback.

## Known caveats / not-yet-done

- Default model IDs (`claude-sonnet-4-6`, `gemini-3.5-flash`, etc.) are future-dated but **valid in this environment** (the configured Anthropic default works). Audit agents flagged them only because of training-cutoff skepticism. Verify secondary providers' defaults against live model lists before release.
- External moves (done outside Obsidian while it isn't running) still rely on the existing fuzzy title/timestamp carry-forward; a contentHash-based relink is the planned fallback.
