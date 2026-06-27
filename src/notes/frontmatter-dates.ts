export interface NoteDatePropertySettings {
	createdDateProperties: string;
	updatedDateProperties: string;
}

export function frontmatterDateMs(
	frontmatter: Record<string, unknown> | undefined,
	propertyNames: string
): number | null {
	if (!frontmatter) return null;
	const names = normalizeDatePropertyNames(propertyNames);
	if (names.length === 0) return null;

	for (const name of names) {
		const direct = frontmatter[name];
		const parsed = parseFrontmatterDateValue(direct);
		if (parsed !== null) return parsed;
	}

	const lowerEntries = new Map(
		Object.entries(frontmatter).map(([key, value]) => [key.toLowerCase(), value])
	);
	for (const name of names) {
		const parsed = parseFrontmatterDateValue(lowerEntries.get(name.toLowerCase()));
		if (parsed !== null) return parsed;
	}

	return null;
}

export function normalizeDatePropertyNames(value: string): string[] {
	const names: string[] = [];
	for (const raw of value.split(",")) {
		const name = raw.trim();
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

function parseFrontmatterDateValue(value: unknown): number | null {
	if (value instanceof Date) return validDateMs(value.getTime());
	if (typeof value === "number") {
		const timestamp = value > 0 && value < 10_000_000_000 ? value * 1000 : value;
		return validDateMs(timestamp);
	}
	if (typeof value !== "string") return null;

	const trimmed = value.trim();
	if (!trimmed) return null;
	const yyyymmdd = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
	if (yyyymmdd) {
		return validDateMs(Date.UTC(
			Number(yyyymmdd[1]),
			Number(yyyymmdd[2]) - 1,
			Number(yyyymmdd[3])
		));
	}
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric) && /^\d+(?:\.\d+)?$/.test(trimmed)) {
		const timestamp = numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
		return validDateMs(timestamp);
	}
	return validDateMs(Date.parse(trimmed));
}

function validDateMs(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	if (value <= 0) return null;
	return value;
}
