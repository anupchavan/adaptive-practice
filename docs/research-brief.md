# Adaptive Practice research brief

This is the current product basis for question generation and scheduling. It should evolve as the plugin gets tested against real vaults.

## Learning principles

- Practice testing and distributed practice are the strongest default bets. Dunlosky et al. rate both as high-utility techniques across ages, content areas, and criterion tasks: https://journals.sagepub.com/doi/abs/10.1177/1529100612453266
- Retrieval practice should ask learners to reconstruct, apply, choose, or transfer knowledge, not merely recognize definitions. Roediger and Karpicke's test-enhanced learning work is the core anchor: https://journals.sagepub.com/doi/abs/10.1111/j.1467-9280.2006.01693.x
- Spacing should be scheduler-owned. Cepeda et al.'s distributed-practice meta-analysis shows retention depends on timing variables, so daily review should combine due items with recently learned or modified notes: https://pubmed.ncbi.nlm.nih.gov/16719566/
- Interleaving is especially important for mathematics and problem-type discrimination. Rohrer/Taylor-style results support mixing similar-looking problem families rather than blocking every question by note: https://files.eric.ed.gov/fulltext/ED557355.pdf
- Desirable difficulties justify effortful questions and delayed review, but only when the learner can still succeed. Bjork and Bjork's framing supports spacing, interleaving, and generation as useful difficulties: https://bjorklab.psych.ucla.edu/wp-content/uploads/sites/13/2016/04/EBjork_RBjork_2011.pdf
- Flow suggests keeping challenge near current skill. Use recent correctness, skips, response time, skill, and difficulty to avoid both trivial recall and demoralizing jumps: https://link.springer.com/article/10.1007/s10902-024-00846-4

## Product rules derived from this

- Store scheduling state in `data.json`; only write the allowed `skill` frontmatter field back to notes.
- Treat the note as structure: frontmatter, tags, links, headings, sections, created/modified time, media embeds, and past practice.
- For large vaults, scan and persist a lightweight skeleton first. Use Obsidian's metadata cache for frontmatter, tags, links, headings, embeds, file stats, and skill so daily scheduling does not require reading tens of thousands of note bodies.
- Read detailed structure and supported attachment bytes only for the notes selected into a session. Keep full outlines but bound body excerpts with representative section sampling so long notes remain useful without consuming the whole prompt budget.
- Ask domain-relative questions: CS favors invariants/edge cases/code behavior; JEE math/physics/chemistry favor modelling, method choice, units, traps, and multi-step reasoning.
- Generate Obsidian Markdown consistently: LaTeX in `$...$` or `$$...$$`, fenced code blocks for code/traces, no markdown fences around JSON responses.
- Prefer daily sessions that mix due, new, changed, low-skill, and slow-recall notes. Avoid repeating practiced subtopics unless the learner struggled or the item is due.
- Treat fluency as separate from correctness. Correct but slow answers should still count as partial fragility, while skips should reduce confidence more strongly than ordinary misses.
- Keep token use bounded: pass note skeletons and section excerpts, attach only a small media budget, cap standalone PDF uploads, and avoid reading the whole vault into a single prompt.

## Model/provider notes

- Gemini supports structured output and multimodal content through `generateContent`: https://ai.google.dev/api/generate-content
- Google documents `gemini-3.5-flash` as a stable Gemini API model with text, image, audio, video, and PDF inputs: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash
- Anthropic supports structured outputs and multimodal messages through the Messages API: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Anthropic retired `claude-sonnet-4-20250514` on June 15, 2026; the documented replacement is `claude-sonnet-4-6`: https://docs.anthropic.com/en/docs/about-claude/model-deprecations
- OpenAI documents `gpt-5.5` as the current migration target. The guide recommends the Responses API for reasoning, tool-calling, or multi-turn use cases; the plugin currently keeps Chat Completions for simple JSON-schema question generation and should migrate in a future provider pass: https://developers.openai.com/api/docs/guides/latest-model
- OpenAI Chat Completions still supports `response_format`; JSON schema is the preferred structured-output route when available: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create/
- DeepSeek exposes `/chat/completions` and documents JSON mode through `response_format: { "type": "json_object" }`; current V4 model IDs include `deepseek-v4-pro` and `deepseek-v4-flash`: https://api-docs.deepseek.com/api/create-chat-completion and https://api-docs.deepseek.com/updates
- Qwen Model Studio exposes an OpenAI-compatible chat interface where migration is mainly API key, base URL, and model-name changes. Alibaba documents `qwen-plus` as currently equivalent to `qwen-plus-2025-12-01`: https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope and https://www.alibabacloud.com/help/en/model-studio/model-pricing
- OpenRouter exposes an OpenAI-compatible `/api/v1/chat/completions` route and can also be configured with provider BYOK in OpenRouter itself. The `openai/gpt-5.4-mini` route supports text and image input with a 400K context window: https://openrouter.ai/docs/quickstart and https://openrouter.ai/docs/guides/overview/auth/byok and https://openrouter.ai/openai/gpt-5.4-mini
- Local/offline options should be considered separately through Ollama or LM Studio, but quality and image/PDF support need empirical testing before they become defaults: https://docs.ollama.com/api/introduction and https://lmstudio.ai/docs/developer/core/server
