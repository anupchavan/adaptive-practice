import { NoteMediaReference, PromptAttachment } from "../types";

const ATTACHABLE_REMOTE_IMAGE_MIME_TYPES = new Set([
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

export interface RemoteMediaFetchResult {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
}

export type RemoteMediaFetcher = (url: string) => Promise<RemoteMediaFetchResult>;

export async function buildRemotePromptAttachment(
	noteTitle: string,
	media: NoteMediaReference,
	remainingBytes: number,
	fetcher: RemoteMediaFetcher
): Promise<PromptAttachment | null> {
	if (remainingBytes <= 0) return null;
	if (media.source !== "remote" || media.kind !== "image" || !media.url) return null;
	const fallbackMimeType = normalizeAttachableImageMimeType(media.mimeType);

	try {
		const response = await fetcher(media.url);
		if (response.status < 200 || response.status >= 300) return null;

		const headerMimeRaw = getHeader(response.headers, "content-type")
			?.split(";")[0]
			?.trim() ?? "";
		const headerMimeType = headerMimeRaw
			? normalizeAttachableImageMimeType(headerMimeRaw)
			: null;
		if (headerMimeRaw && !headerMimeType) return null;

		const mimeType = headerMimeType ?? fallbackMimeType;
		if (!mimeType) return null;
		if (response.arrayBuffer.byteLength <= 0) return null;
		if (response.arrayBuffer.byteLength > remainingBytes) return null;

		return {
			noteTitle,
			path: media.url,
			kind: "image",
			mimeType,
			data: response.arrayBuffer,
		};
	} catch {
		return null;
	}
}

function normalizeAttachableImageMimeType(mimeType: string): string | null {
	const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (normalized === "image/jpg") return "image/jpeg";
	if (ATTACHABLE_REMOTE_IMAGE_MIME_TYPES.has(normalized)) return normalized;
	return null;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) return value;
	}
	return undefined;
}
