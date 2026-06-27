export function stringifyGroupValue(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) {
		return value
			.map((item) => stringifyGroupValue(item))
			.filter(Boolean)
			.join(", ");
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return "";
}

export function folderLabel(path: string): string {
	const parts = path.split("/").filter(Boolean);
	if (parts.length <= 1) return "";
	const parent = parts[parts.length - 2] ?? "";
	const grandparent = parts[parts.length - 3] ?? "";
	if (parent.toLowerCase() === "assets" && grandparent) return grandparent;
	return parent;
}
