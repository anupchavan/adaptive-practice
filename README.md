# Adaptive Practice

Adaptive Practice is an Obsidian community plugin that helps you practice and retain knowledge from your notes using spaced repetition and adaptive scheduling.

## Features

- Generate adaptive practice questions directly from Obsidian notes and PDFs.
- Maintain a lightweight vault skeleton index with frontmatter, tags, links, headings, file stats, and embedded media references.
- Read selected notes more deeply at generation time, including frontmatter, outline, bounded section excerpts, and supported attachments.
- Daily practice reminders with a spaced, skill-aware topic queue stored in plugin data.
- Fluency-aware review that uses correctness, skips, and response time to detect fragile recall.
- A dashboard view for streak, due notes, scan status, and one-click daily practice.
- Multi-provider BYOK support for Gemini, Anthropic, OpenAI, DeepSeek, Qwen, OpenRouter, local Ollama, and custom OpenAI-compatible endpoints.
- Obsidian-native Markdown output with LaTeX and code block guidance in the generation prompt.

## Model providers

Open **Settings → Adaptive Practice** and choose a provider, then select or create the Obsidian secret that stores that provider's API key. API keys are stored through Obsidian secret storage. Each provider keeps its own configurable secret name, so switching between Gemini, Anthropic, OpenAI-compatible routes, etc. does not overwrite the key slot you chose for another provider.

| Provider | Default endpoint/model | Notes |
| --- | --- | --- |
| Gemini | `gemini-3.5-flash` | Supports image and PDF attachments through the Gemini API. Change the model in settings if your account uses a different Gemini model. |
| Anthropic | `https://api.anthropic.com/v1/messages`, `claude-sonnet-4-6` | Supports image and PDF attachments through the Messages API. Change the model in settings if your account uses a different Claude model. |
| OpenAI | `https://api.openai.com/v1/responses`, `gpt-5.5` | Uses the Responses API with structured JSON output. Change the model in settings if your account uses a different OpenAI model. |
| DeepSeek | `https://api.deepseek.com/chat/completions`, `deepseek-v4-flash` | Uses OpenAI-compatible chat completions with JSON object mode. Change the model in settings if you want the pro route. |
| Qwen | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions`, `qwen3.7-plus` | Uses Alibaba Cloud Model Studio's OpenAI-compatible interface. Change the model in settings if your region or account uses another Qwen route. |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions`, `openai/gpt-5.4-mini` | Uses OpenRouter's OpenAI-compatible route. Change the model to any route you have access to. |
| Ollama (local) | `http://localhost:11434/v1/chat/completions`, `llama3.1` | Runs against your local Ollama server. No API key, free, fully offline. Pick any pulled model in settings. |
| OpenAI-compatible | `http://localhost:1234/v1/chat/completions` | For LM Studio, local gateways, or other compatible servers. Local endpoints may omit an API key. |

Image attachments are sent only when the selected provider is configured to support vision input. PDF/document attachments currently require Gemini or Anthropic. The note picker warns and blocks PDF-topic sessions for providers that cannot read PDF attachments through this plugin yet; daily practice skips incompatible PDF topics and uses compatible due notes when available. Standalone PDF topics are capped at 10 MB per file before upload.

## Daily practice

Use the **Open dashboard** command or the "brain" ribbon icon to open the Adaptive Practice dashboard. The dashboard shows your current streak, how many notes are ready for review, the last vault scan, and the selected daily review topics. From there you can start the daily session, choose notes manually, or rescan the vault skeleton.

When choosing notes manually, the picker uses practice memory to sort due and low-skill notes first. You can search by title/path, filter to due/new/low-skill/PDF notes, and select all currently visible matches without rendering the whole vault at once.

The scan is incremental: unchanged notes reuse their previous skeleton entry, while changed notes refresh metadata from Obsidian's cache. Scans yield back to Obsidian between batches so large vaults do not freeze the UI during startup or scheduled rescans. This keeps daily topic selection cheap enough for large vaults while still letting generation read the selected notes in detail. For very large notes, prompts keep the outline and sample representative section excerpts so a single clipped or encyclopedic note does not consume the whole context window.

After a session, the scheduler updates each note with recent accuracy, skipped answers, rolling average time, and a fluency score. Slow or skipped recall shortens the next interval and can bring a note forward in the daily queue even when the overall skill score is not low.

Adaptive Practice also tracks generated `sourceSubtopics` per note. Future prompts receive a compact subtopic memory block so the model can avoid already-mastered subtopics and revisit weak or due ones without rereading the full practice log.

Daily sessions also adjust the generated question count before calling the model: fragile recall gets a shorter warm-up, balanced review keeps your configured count, and strong recent accuracy/fluency earns a small stretch. This keeps token use bounded while nudging the session toward flow instead of a fixed-size batch every day.

---

## Requirements

- Obsidian v1.11.4 or higher (desktop or mobile; desktop recommended for initial install).
- Node.js (LTS, v18+ recommended) for local builds.
- Git (for install via cloning).

---

## Installation

You can install this plugin in two main ways:

1. **Via Git clone + `npm install` (manual install)**
2. **Via the BRAT plugin (recommended for tracking this repo)**

### 1. Manual Installation (Git clone + npm)

This method is best if you want to develop, tweak, or inspect the source.

1. **Clone the repository**

   ```bash
   cd /path/to/your/vault/.obsidian/plugins
   git clone https://github.com/anupchavan/adaptive-practice.git
   cd adaptive-practice
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Build the plugin**

   For a one-time production build:

   ```bash
   npm run build
   ```

   Or for development with watch:

   ```bash
   npm run dev
   ```

   After a successful build, you should have:

   - `main.js`
   - `manifest.json`
   - (optionally) `styles.css`

   at the root of the `adaptive-practice` plugin folder.

4. **Enable the plugin in Obsidian**

   - Open Obsidian.
   - Go to **Settings → Community plugins**.
   - Make sure **Safe mode** is turned off.
   - Select **Browse**, then **Installed plugins**.
   - Find **Adaptive Practice** and toggle it **on**.

---

### 2. Installation via BRAT (Beta Reviewers Auto-update Tester)

If you’d like Obsidian to automatically keep this plugin updated from a GitHub repo, you can use the [**BRAT**](https://obsidian.md/plugins?search=brat) plugin.

1. **Install BRAT**

   - In Obsidian, go to **Settings → Community plugins**.
   - Select **Browse**.
   - Search for **“BRAT”** (Beta Reviewers Auto-update Tester).
   - Install and enable **BRAT**.

2. **Add this plugin as a beta plugin in BRAT**

   - Open **Command palette** (**Cmd/Ctrl+P**) and run:
     - **“BRAT: Add a beta plugin for testing”**
   - When prompted for the GitHub repository, enter:

     ```text
     anupchavan/adaptive-practice
     ```


3. **Enable the plugin**

   - BRAT will download the plugin into your vault.
   - Go to **Settings → Community plugins → Installed plugins**.
   - Enable **Adaptive Practice**.

4. **Auto-updates**

   - BRAT can periodically check for updates from the GitHub repo and update the installed plugin.
   - Configure BRAT’s update settings from **Settings → Community plugins → BRAT** as desired.

---

## Development

If you want to modify the plugin:

1. Make sure you are in the plugin directory:

   ```bash
   cd /path/to/your/vault/.obsidian/plugins/adaptive-practice
   ```

2. Run the dev build:

   ```bash
   npm run dev
   ```

3. After each change is built, reload Obsidian (or use **“Reload app without saving”** from the Command palette) to see the changes.

---

## Support & Feedback

- For bugs or feature requests, please open an issue on the GitHub repository.
- If you find this plugin useful, consider starring the repo to show support.

---
