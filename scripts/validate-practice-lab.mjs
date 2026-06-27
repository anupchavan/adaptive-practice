import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const VAULT_ROOT = path.resolve(process.cwd(), "../../..");
const PRACTICE_LAB_DIR = path.join(VAULT_ROOT, "Practice Lab");
const DEFAULT_CS_DIR = path.join(PRACTICE_LAB_DIR, "CS Wikipedia");
const CS_DIR = readStringFlag("--dir", readStringFlag("--cs-dir", DEFAULT_CS_DIR));
const JEE_ROOT = readStringFlag("--jee-root", PRACTICE_LAB_DIR);
const MIN_NOTES = readNumberFlag("--min-notes", 400);
const MIN_IMAGE_NOTES = readNumberFlag("--min-image-notes", 200);
const MIN_CODE_NOTES = readNumberFlag("--min-code-notes", 50);
const MIN_NOTE_CHARS = readNumberFlag("--min-note-chars", 1_800);
const MIN_JEE_SUBJECT_COUNTS = {
	"JEE Mathematics": readNumberFlag("--min-jee-math", 6),
	"JEE Physics": readNumberFlag("--min-jee-physics", 5),
	"JEE Chemistry": readNumberFlag("--min-jee-chemistry", 6),
};

assert.ok(existsSync(CS_DIR), `CS lab directory does not exist: ${CS_DIR}`);

const files = readdirSync(CS_DIR).filter((file) => file.endsWith(".md"));
assert.ok(
	files.length >= MIN_NOTES,
	`Expected at least ${MIN_NOTES} Markdown notes, found ${files.length}`
);

const manifestPath = path.join(CS_DIR, "_import-manifest.json");
assert.ok(existsSync(manifestPath), "CS Wikipedia import manifest is missing");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.match(
	String(manifest.method ?? ""),
	/curl Wikipedia HTML \+ self-hosted Defuddle/i,
	"Manifest must prove the importer used curl plus self-hosted Defuddle"
);
assert.match(
	String(manifest.method ?? ""),
	/no Wikipedia API/i,
	"Manifest must explicitly say the importer avoided the Wikipedia API"
);
assert.match(
	String(manifest.method ?? ""),
	/no public defuddle\.md endpoint/i,
	"Manifest must explicitly say the importer avoided public Defuddle endpoints"
);

const badTitles = [];
const disambiguationLeaks = [];
const personLeaks = [];
const shortNotes = [];
const missingFrontmatter = [];
let imageNotes = 0;
let codeNotes = 0;

for (const file of files) {
	const text = readFileSync(path.join(CS_DIR, file), "utf8");
	const lead = text.slice(0, 2_200);

	if (isFilteredTitle(file.replace(/\.md$/, ""))) badTitles.push(file);
	if (/may refer to:|may also refer to:|this disambiguation page lists/i.test(lead)) {
		disambiguationLeaks.push(file);
	}
	if (looksLikePersonArticle(lead)) personLeaks.push(file);
	if (text.length < MIN_NOTE_CHARS) shortNotes.push(file);
	if (!hasRequiredFrontmatter(text)) missingFrontmatter.push(file);
	if (/!\[[^\]]*]\(/.test(text)) imageNotes++;
	if (/```/.test(text)) codeNotes++;
}

assert.deepEqual(badTitles, [], `Filtered titles leaked into lab: ${badTitles.slice(0, 10).join(", ")}`);
assert.deepEqual(
	disambiguationLeaks,
	[],
	`Disambiguation pages leaked into lab: ${disambiguationLeaks.slice(0, 10).join(", ")}`
);
assert.deepEqual(personLeaks, [], `Person pages leaked into lab: ${personLeaks.slice(0, 10).join(", ")}`);
assert.deepEqual(shortNotes, [], `Short or stub notes leaked into lab: ${shortNotes.slice(0, 10).join(", ")}`);
assert.deepEqual(
	missingFrontmatter,
	[],
	`Notes are missing required Adaptive Practice frontmatter: ${missingFrontmatter.slice(0, 10).join(", ")}`
);
assert.ok(
	imageNotes >= MIN_IMAGE_NOTES,
	`Expected at least ${MIN_IMAGE_NOTES} notes with images, found ${imageNotes}`
);
assert.ok(
	codeNotes >= MIN_CODE_NOTES,
	`Expected at least ${MIN_CODE_NOTES} notes with fenced code, found ${codeNotes}`
);

const jeeSummary = validateJeeLab();

console.log(
	`practice lab ok: ${files.length} CS notes, ${imageNotes} with images, ${codeNotes} with fenced code; ` +
	`${jeeSummary.noteCount} JEE notes across math/physics/chemistry, ${jeeSummary.mediaEmbeds} media embeds`
);

function validateJeeLab() {
	const assetsDir = path.join(JEE_ROOT, "Assets");
	assert.ok(existsSync(assetsDir), `JEE assets directory does not exist: ${assetsDir}`);

	const assets = readdirSync(assetsDir);
	const svgCount = assets.filter((file) => file.endsWith(".svg")).length;
	const pngCount = assets.filter((file) => file.endsWith(".png")).length;
	const pdfCount = assets.filter((file) => file.endsWith(".pdf")).length;
	assert.ok(svgCount >= 2, `Expected at least 2 SVG assets, found ${svgCount}`);
	assert.ok(pngCount >= 1, `Expected at least 1 PNG asset, found ${pngCount}`);
	assert.ok(pdfCount >= 1, `Expected at least 1 PDF asset, found ${pdfCount}`);

	const indexPath = path.join(JEE_ROOT, "JEE Lab Index.md");
	assert.ok(existsSync(indexPath), "JEE Lab Index.md is missing");
	const indexText = readFileSync(indexPath, "utf8");

	const allNotes = [];
	for (const [subject, minimum] of Object.entries(MIN_JEE_SUBJECT_COUNTS)) {
		const subjectDir = path.join(JEE_ROOT, subject);
		assert.ok(existsSync(subjectDir), `${subject} directory is missing`);
		const notes = readdirSync(subjectDir).filter((file) => file.endsWith(".md"));
		assert.ok(
			notes.length >= minimum,
			`Expected at least ${minimum} ${subject} notes, found ${notes.length}`
		);

		for (const note of notes) {
			const fullPath = path.join(subjectDir, note);
			const text = readFileSync(fullPath, "utf8");
			const linkTarget = `[[Practice Lab/${subject}/${note.replace(/\.md$/, "")}]]`;
			assert.ok(indexText.includes(linkTarget), `Index is missing link to ${note}`);
			validateJeeNote(text, subject, note);
			allNotes.push({ subject, note, text });
		}
	}

	const mediaEmbeds = allNotes.filter(({ text }) => /!\[\[Practice Lab\/Assets\//.test(text)).length;
	const codeNotes = allNotes.filter(({ text }) => /```/.test(text)).length;
	const clippedNoiseNotes = allNotes.filter(({ text }) =>
		/\b(cookie|Subscribe|Share|Advertisement|Open app|Open in app|Download PDF|Recommended|Telegram)\b/i.test(text)
	).length;

	assert.ok(mediaEmbeds >= 6, `Expected at least 6 JEE notes with media embeds, found ${mediaEmbeds}`);
	assert.ok(codeNotes >= 6, `Expected at least 6 JEE notes with fenced code blocks, found ${codeNotes}`);
	assert.ok(
		clippedNoiseNotes >= 8,
		`Expected at least 8 JEE notes with clipped/noisy student-vault text, found ${clippedNoiseNotes}`
	);

	return {
		noteCount: allNotes.length,
		mediaEmbeds,
	};
}

function validateJeeNote(text, subject, note) {
	assert.ok(/^---\n[\s\S]+?\n---\n/.test(text), `${note} is missing frontmatter`);
	assert.ok(text.includes(`course: ${subject}`), `${note} is missing course: ${subject}`);
	assert.ok(/\ncreated:\s*\d{4}-\d{2}-\d{2}\n/.test(text), `${note} is missing created date`);
	assert.ok(/\nupdated:\s*\d{4}-\d{2}-\d{2}\n/.test(text), `${note} is missing updated date`);
	assert.ok(/\nskill:\s*"?\d+(?:\.\d+)?"?\n/.test(text), `${note} is missing numeric skill`);
	assert.ok(/\$[^$\n]+\$|^\$\$/m.test(text), `${note} should include LaTeX for JEE practice`);
}

function hasRequiredFrontmatter(text) {
	return /^---\n[\s\S]+?\n---\n/.test(text) &&
		/\nadaptive-practice:\s*true\n/.test(text) &&
		/\nsource_site:\s*"Wikipedia"\n/.test(text) &&
		/\nsource_license:\s*"CC BY-SA 4\.0"\n/.test(text) &&
		/\n {2}- adaptive-practice\/imported\n/.test(text);
}

function looksLikePersonArticle(lead) {
	return /\b(born|died)\b/i.test(lead) &&
		/\b(computer scientist|mathematician|engineer|inventor|entrepreneur|physicist)\b/i.test(lead);
}

function isFilteredTitle(title) {
	return /\b(disambiguation|people|births|deaths)\b/i.test(title) ||
		/^(List of|Index of|Outline of|Timeline of|Glossary of|Bibliography of|Category:|File:|Help:|Wikipedia:|Template:|Portal:)/i.test(title);
}

function readNumberFlag(flag, fallback) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	const value = Number(process.argv[index + 1]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readStringFlag(flag, fallback) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	return process.argv[index + 1] ?? fallback;
}
