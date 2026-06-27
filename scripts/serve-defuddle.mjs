import http from "node:http";
import { Defuddle } from "defuddle/node";

const HOST = readStringFlag("--host", process.env.DEFUDDLE_HOST ?? "127.0.0.1");
const PORT = readNumberFlag("--port", Number(process.env.DEFUDDLE_PORT) || 8787);
const MAX_BODY_BYTES = readNumberFlag("--max-body-bytes", 16 * 1024 * 1024);

const server = http.createServer(async (request, response) => {
	try {
		const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? `${HOST}:${PORT}`}`);
		if (request.method === "GET" && requestUrl.pathname === "/health") {
			sendJson(response, 200, { ok: true });
			return;
		}

		if (request.method !== "POST" || requestUrl.pathname !== "/api/parse") {
			sendJson(response, 404, { error: "Use POST /api/parse with { html, url }." });
			return;
		}

		const body = await readJsonBody(request);
		if (!body.html || typeof body.html !== "string") {
			sendJson(response, 400, { error: "Missing string field: html" });
			return;
		}
		const sourceUrl = typeof body.url === "string" ? body.url : "about:blank";
		const result = await Defuddle(body.html, sourceUrl, { markdown: true });
		sendJson(response, 200, {
			content: result.content,
			title: result.title,
			description: result.description,
			domain: result.domain,
			image: result.image,
			language: result.language,
			published: result.published,
			author: result.author,
			site: result.site,
			wordCount: result.wordCount,
		});
	} catch (error) {
		sendJson(response, 500, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
});

server.listen(PORT, HOST, () => {
	console.log(`Self-hosted Defuddle listening at http://${HOST}:${PORT}`);
});

function sendJson(response, status, body) {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Access-Control-Allow-Origin": "*",
	});
	response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
		}
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8");
	return JSON.parse(text || "{}");
}

function readNumberFlag(flag, fallback) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	const value = Number(process.argv[index + 1]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readStringFlag(flag, fallback) {
	const index = process.argv.indexOf(flag);
	if (index === -1) return fallback;
	return process.argv[index + 1] ?? fallback;
}
