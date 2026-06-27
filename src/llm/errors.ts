export interface ProviderErrorContext {
	providerLabel: string;
	status: number;
	model?: string;
	baseUrl?: string;
	detail?: string;
}

export function extractProviderErrorDetail(rawText: string): string {
	try {
		const data: unknown = JSON.parse(rawText);
		return getProviderErrorMessage(data) ?? rawText;
	} catch {
		return rawText;
	}
}

export function formatProviderError(context: ProviderErrorContext): string {
	const bits = [`${context.providerLabel} API error (${context.status})`];
	if (context.model) bits.push(`model "${context.model}"`);
	if (context.baseUrl) bits.push(`endpoint ${context.baseUrl}`);

	const action = suggestedAction(context);
	const detail = context.detail?.trim();
	return `${bits.join(" for ")}${detail ? `: ${detail}` : ""}${action ? ` ${action}` : ""}`;
}

function suggestedAction(context: ProviderErrorContext): string {
	const detail = context.detail?.toLowerCase() ?? "";
	if (
		context.status === 404 ||
		/\b(model|not found|does not exist|unknown model|invalid model)\b/i.test(detail)
	) {
		return "Check the model name in Settings -> Adaptive Practice, or pick a model currently enabled for this provider account.";
	}
	if (context.status === 401 || context.status === 403) {
		return "Check the API key and provider account permissions in Settings -> Adaptive Practice.";
	}
	if (context.status === 400 && /response_format|text\.format|json_schema|json object|schema/i.test(detail)) {
		return "Try changing this provider's JSON mode in Settings -> Adaptive Practice.";
	}
	if (context.status === 429) {
		return "The provider is rate-limiting this key; wait a bit or lower request volume.";
	}
	if (context.status >= 500) {
		return "The provider endpoint returned a server error; retry later or switch models.";
	}
	if (context.baseUrl && /failed to fetch|network|enotfound|econnrefused|timeout/i.test(detail)) {
		return "Check the configured base URL and whether the local/provider server is reachable.";
	}
	return "";
}

function getProviderErrorMessage(data: unknown): string | null {
	if (!isRecord(data)) return null;
	const error = data["error"];
	if (typeof error === "string") return error;
	if (isRecord(error)) {
		const message = error["message"] ?? error["error"] ?? error["detail"];
		if (typeof message === "string") return message;
	}
	const message = data["message"] ?? data["detail"];
	return typeof message === "string" ? message : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}
