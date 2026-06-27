export interface LocalMediaLink {
	path: string;
	alt: string;
	caption?: string;
}

export function mergeLocalMediaLink(
	links: Map<string, LocalMediaLink>,
	next: LocalMediaLink
): void {
	const existing = links.get(next.path);
	if (!existing) {
		links.set(next.path, next);
		return;
	}
	const alt = isBetterMediaText(next.alt, existing.alt) ? next.alt : existing.alt;
	const caption = existing.caption?.trim() || next.caption?.trim() || undefined;
	links.set(next.path, { path: next.path, alt, ...(caption ? { caption } : {}) });
}

function isBetterMediaText(next: string, previous: string): boolean {
	const cleanedNext = next.trim();
	const cleanedPrevious = previous.trim();
	if (!cleanedNext) return false;
	if (!cleanedPrevious) return true;
	if (cleanedPrevious === cleanedNext) return false;
	return isLikelyPathLabel(cleanedPrevious) && !isLikelyPathLabel(cleanedNext);
}

function isLikelyPathLabel(value: string): boolean {
	return /[/\\]/.test(value) ||
		/\.(png|jpe?g|webp|gif|svg|pdf)$/i.test(value);
}
