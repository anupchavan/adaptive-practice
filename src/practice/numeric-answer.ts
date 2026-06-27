export function parseNumericAnswer(input: string): number | null {
	const cleaned = normalizeNumericText(input);
	const fraction = parseFraction(cleaned);
	if (fraction !== null) return fraction;

	const match = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(cleaned);
	if (!match) return null;
	const parsed = Number(match[0]);
	return Number.isFinite(parsed) ? parsed : null;
}

export function isIntegerLike(value: number): boolean {
	return Math.abs(value - Math.round(value)) < 1e-9;
}

function normalizeNumericText(input: string): string {
	return input
		.trim()
		.replace(/^\$+|\$+$/g, "")
		.replace(/^\\\(|\\\)$/g, "")
		.replace(/^\\\[|\\\]$/g, "")
		.replace(/\\left|\\right/g, "")
		.replace(/[,\s]/g, "")
		.replace(/[−–—]/g, "-")
		.replace(/\\cdot|\\times|×/gi, "*")
		.replace(/\*?10\^\{?([+-]?\d+)\}?/gi, "e$1");
}

function parseFraction(input: string): number | null {
	const latex = /\\frac\{([^{}]+)\}\{([^{}]+)\}/.exec(input);
	if (latex) {
		const numerator = parseNumericAnswer(latex[1] ?? "");
		const denominator = parseNumericAnswer(latex[2] ?? "");
		if (numerator !== null && denominator !== null && denominator !== 0) {
			return numerator / denominator;
		}
	}

	const plain = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\/([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(input);
	if (!plain) return null;
	const numerator = Number(plain[1]);
	const denominator = Number(plain[2]);
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
		return null;
	}
	return numerator / denominator;
}
