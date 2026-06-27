import { NoteMediaReference } from "../types";

export interface PromptAttachmentOptions {
	includeImages?: boolean;
	includePdfs?: boolean;
}

export function shouldAttachPromptMedia(
	media: Pick<NoteMediaReference, "kind" | "mimeType">,
	options: PromptAttachmentOptions = {}
): boolean {
	const includeImages = options.includeImages ?? true;
	const includePdfs = options.includePdfs ?? true;
	if (media.kind === "image") return includeImages;
	if (media.kind === "pdf") return includePdfs;
	return false;
}
