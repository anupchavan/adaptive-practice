// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
    globalIgnores([
        "node_modules",
        "main.js",
        "esbuild.config.mjs",
        "eslint.config.js",
        "eslint.config.mts",
        "version-bump.mjs",
        "versions.json",
        "vault-generator/node_modules",
        "vault-generator/.wiki_tmp",
    ]),
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsparser,
            globals: {
                ...globals.browser,
                createEl: "readonly",
                createFragment: "readonly",
                activeDocument: "readonly",
            },
            parserOptions: { project: "./tsconfig.json" },
        },

        rules: {
            "obsidianmd/sample-names": "off",
        },
    },
    {
        files: ["tests/**/*.ts"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "import/no-nodejs-modules": "off",
            "no-console": "off",
        },
    },
    {
        files: ["tests/**/*.mjs"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ["scripts/**/*.mjs"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
        rules: {
            "no-console": "off",
        },
    },
]);
