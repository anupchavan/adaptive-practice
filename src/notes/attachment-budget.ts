export const MAX_PDF_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export function pdfAttachmentSizeError(
	path: string,
	sizeBytes: number,
	maxBytes = MAX_PDF_ATTACHMENT_BYTES
): string {
	if (sizeBytes <= maxBytes) return "";
	return `PDF topic "${path}" is ${formatBytes(sizeBytes)}; Adaptive Practice attaches PDFs up to ${formatBytes(maxBytes)}. Split or compress the PDF, or extract the relevant pages into notes before practicing it.`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}
	const rounded = value >= 10 || unitIndex === 0
		? Math.round(value)
		: Math.round(value * 10) / 10;
	return `${rounded} ${units[unitIndex]}`;
}
