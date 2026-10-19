/**
 * DeepSeek Search & Fetch tools for pi.
 *
 * API: https://api-docs.deepseek.com/guides/search/
 * Auth: the `deepseek` provider credentials configured in pi (/login or auth.json),
 * falling back to the DEEPSEEK_API_KEY environment variable.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MAX_ATTEMPTS = 3;
// Per-result cap when need_content is on, so one long page doesn't crowd out the rest.
const MAX_CONTENT_CHARS = 4000;

interface SearchResult {
	rerank_score?: number;
	title?: string;
	url: string;
	snippet?: string;
	summary?: string;
	content?: string;
	site_name?: string;
	date?: string | null;
	authority?: number;
}

interface SearchDetails {
	query: string;
	count: number;
	results: Array<Pick<SearchResult, "title" | "url" | "site_name" | "date">>;
}

interface FetchDetails {
	url: string;
	title?: string;
	bytes: number;
	truncated: boolean;
	fullOutputPath?: string;
}

class DeepSeekError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function resolveApiKey(ctx: ExtensionToolContext): Promise<string> {
	const key = (await ctx.modelRegistry.getApiKeyForProvider("deepseek")) ?? process.env.DEEPSEEK_API_KEY;
	if (!key) {
		throw new Error("DeepSeek API key not found. Configure the `deepseek` provider in pi or set DEEPSEEK_API_KEY.");
	}
	return key;
}

function isRetryable(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

async function callApi<T>(path: string, body: unknown, apiKey: string, signal?: AbortSignal): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(`${BASE_URL}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		if (res.ok) return (await res.json()) as T;

		const text = await res.text();
		let message = text;
		try {
			message = JSON.parse(text)?.error?.message ?? text;
		} catch {}

		if (isRetryable(res.status) && attempt < MAX_ATTEMPTS) {
			const retryAfter = Number(res.headers.get("retry-after"));
			await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1), signal);
			continue;
		}
		throw new DeepSeekError(res.status, `DeepSeek ${path} failed (HTTP ${res.status}): ${message}`);
	}
}

function formatResult(r: SearchResult, i: number, withContent: boolean): string {
	const meta = [r.site_name, r.date?.slice(0, 10)].filter(Boolean).join(" · ");
	const lines = [`${i + 1}. ${r.title ?? r.url}`, `   ${r.url}`];
	if (meta) lines.push(`   ${meta}`);
	const body = withContent && r.content ? r.content.slice(0, MAX_CONTENT_CHARS) : (r.summary ?? r.snippet);
	if (body) lines.push(body.replace(/^/gm, "   "));
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "deepseek_search",
		label: "DeepSeek Search",
		description:
			"Search the web with DeepSeek Search API. Returns ranked results with title, URL, site, date and a summary. " +
			"Query supports operators: site:example.com, -site:example.com, lang:en, after:2025-01-01, before:2025-12-31, \"exact phrase\". " +
			"Use deepseek_fetch to read a full page.",
		promptSnippet: "deepseek_search: search the web (DeepSeek Search API)",
		promptGuidelines: [
			"Use deepseek_search for up-to-date information from the web; follow up with deepseek_fetch to read promising pages in full.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query, 1-128 characters. Operators allowed.", minLength: 1, maxLength: 128 }),
			count: Type.Optional(Type.Integer({ description: "Number of results, 1-50 (default 10)", minimum: 1, maximum: 50 })),
			need_content: Type.Optional(
				Type.Boolean({ description: "Include page content for each result (default false). Increases output size." }),
			),
			ori_question: Type.Optional(
				Type.String({ description: "The user's original question, improves ranking (max 128 chars)", maxLength: 128 }),
			),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = await resolveApiKey(ctx);
			const count = params.count ?? 10;
			const data = await callApi<{ results?: SearchResult[] }>(
				"/v1/tools/search",
				{
					query: params.query,
					count,
					need_content: params.need_content ?? false,
					...(params.ori_question ? { ori_question: params.ori_question } : {}),
				},
				apiKey,
				signal,
			);
			const results = data.results ?? [];
			const details: SearchDetails = {
				query: params.query,
				count: results.length,
				results: results.map(({ title, url, site_name, date }) => ({ title, url, site_name, date })),
			};
			if (results.length === 0) {
				return { content: [{ type: "text", text: `No results for "${params.query}".` }], details };
			}

			const text = results.map((r, i) => formatResult(r, i, params.need_content ?? false)).join("\n\n");
			const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let output = truncation.content;
			if (truncation.truncated) {
				output += `\n\n[Output truncated to ${formatSize(truncation.outputBytes)}. Reduce count or disable need_content.]`;
			}
			return { content: [{ type: "text", text: output }], details };
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("deepseek_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.count) text += theme.fg("dim", ` ×${args.count}`);
			if (args.need_content) text += theme.fg("dim", " +content");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			const details = result.details as SearchDetails | undefined;
			if (!details || details.count === 0) return new Text(theme.fg("dim", "No results"), 0, 0);
			let text = theme.fg("success", `${details.count} results`);
			const shown = expanded ? details.results : details.results.slice(0, 3);
			for (const r of shown) {
				text += `\n${theme.fg("accent", r.title ?? r.url)} ${theme.fg("dim", r.url)}`;
			}
			if (!expanded && details.results.length > shown.length) {
				text += `\n${theme.fg("muted", `... ${details.results.length - shown.length} more`)}`;
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "deepseek_fetch",
		label: "DeepSeek Fetch",
		description:
			`Fetch a web page via DeepSeek Fetch API and return its content as Markdown. ` +
			`Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; the full page is then saved to a temp file.`,
		promptSnippet: "deepseek_fetch: read a web page as Markdown (DeepSeek Fetch API)",
		parameters: Type.Object({
			url: Type.String({ description: "HTTP(S) URL to fetch, up to 8192 characters", maxLength: 8192 }),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = await resolveApiKey(ctx);
			let data: { title?: string; content?: string };
			try {
				data = await callApi("/v1/tools/fetch", { url: params.url }, apiKey, signal);
			} catch (err) {
				if (err instanceof DeepSeekError && err.status === 403) {
					throw new Error(`Fetching ${params.url} was rejected by DeepSeek security policy.`);
				}
				if (err instanceof DeepSeekError && err.status === 404) {
					throw new Error(`DeepSeek could not retrieve usable content from ${params.url}.`);
				}
				throw err;
			}

			const page = `${data.title ? `# ${data.title}\n\n` : ""}${data.content ?? ""}`;
			const details: FetchDetails = {
				url: params.url,
				title: data.title,
				bytes: Buffer.byteLength(page),
				truncated: false,
			};
			const truncation = truncateHead(page, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			let output = truncation.content;
			if (truncation.truncated) {
				const dir = await mkdtemp(join(tmpdir(), "pi-ds-fetch-"));
				const file = join(dir, "page.md");
				await writeFile(file, page, "utf8");
				details.truncated = true;
				details.fullOutputPath = file;
				output +=
					`\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
					`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full page saved to: ${file}]`;
			}
			return { content: [{ type: "text", text: output }], details };
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("deepseek_fetch ")) + theme.fg("accent", args.url), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			const details = result.details as FetchDetails | undefined;
			if (!details) return new Text("", 0, 0);
			let text = theme.fg("success", details.title ?? details.url) + theme.fg("dim", ` (${formatSize(details.bytes)})`);
			if (details.truncated) text += theme.fg("warning", " (truncated)");
			if (expanded && details.fullOutputPath) text += `\n${theme.fg("dim", `Full page: ${details.fullOutputPath}`)}`;
			return new Text(text, 0, 0);
		},
	});
}
