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
	if (!isSafeRemoteAttachmentUrl(media.url)) return null;
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

export function isSafeRemoteAttachmentUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") return false;
	if (url.username || url.password) return false;
	const hostname = url.hostname.toLowerCase();
	if (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "0.0.0.0"
	) {
		return false;
	}
	if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) return false;
	return true;
}

function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => Number(part));
	if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return false;
	}
	const [a = 0, b = 0] = octets;
	return (
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168)
	);
}

function isPrivateIpv6(hostname: string): boolean {
	const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
	return (
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe80:")
	);
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
