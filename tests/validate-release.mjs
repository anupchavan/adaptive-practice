import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");
const versions = readJson("versions.json");
const readme = readFileSync("README.md", "utf8");

assert.equal(manifest.id, "adaptive-practice");
assert.equal(manifest.version, packageJson.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(packageJson.main, "main.js");

for (const key of ["name", "version", "minAppVersion", "description", "author"]) {
	assert.ok(String(manifest[key] ?? "").trim(), `manifest.${key} is required`);
}
assert.equal(typeof manifest.isDesktopOnly, "boolean");
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
assert.ok(
	readme.includes(`Obsidian v${manifest.minAppVersion} or higher`),
	"README requirements must match manifest.minAppVersion"
);

for (const file of ["main.js", "manifest.json", "styles.css"]) {
	assert.ok(existsSync(file), `${file} must exist before release`);
}

console.log("release metadata is consistent");

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}
