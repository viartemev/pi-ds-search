# pi-ds-search

Web search and page fetching for [pi](https://pi.dev) via the [DeepSeek Search & Fetch API](https://api-docs.deepseek.com/guides/search/).

Adds two tools the agent can call:

| Tool | Endpoint | What it does |
|---|---|---|
| `deepseek_search` | `POST /v1/tools/search` | Searches the web and returns ranked results with title, URL, site, date and a model-oriented summary |
| `deepseek_fetch` | `POST /v1/tools/fetch` | Fetches a single page and returns its content as Markdown |

## Install

```bash
pi install git:github.com/viartemev/pi-ds-search
```

Try it for one session without changing your settings:

```bash
pi -e git:github.com/viartemev/pi-ds-search
```

Or from a local checkout:

```bash
git clone https://github.com/viartemev/pi-ds-search
pi install ./pi-ds-search
```

## Authentication

The extension reuses the credentials of pi's `deepseek` provider, so if you already use DeepSeek models in pi there is nothing to configure.

Otherwise, set an API key from the [DeepSeek platform](https://platform.deepseek.com/api_keys):

```bash
export DEEPSEEK_API_KEY=sk-...
```

| Variable | Default | Purpose |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | API key, used when the `deepseek` provider has no credentials in pi |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Override the API base URL (proxy, gateway) |

## Tools

### `deepseek_search`

| Parameter | Type | Description |
|---|---|---|
| `query` | string, required | 1–128 characters. Supports operators: `site:example.com`, `-site:example.com`, `lang:en`, `after:2025-01-01`, `before:2025-12-31`, `"exact phrase"` |
| `count` | integer | Number of results, 1–50 (default 10) |
| `need_content` | boolean | Include page content for each result instead of the summary (capped at 4000 chars per result) |
| `ori_question` | string | The user's original question; helps ranking |

Example prompt:

> Find the latest release notes for Bun, only from bun.sh, after 2026-01-01

The model will issue something like `deepseek_search({ query: "release notes site:bun.sh after:2026-01-01" })` and then call `deepseek_fetch` on the most relevant result.

### `deepseek_fetch`

| Parameter | Type | Description |
|---|---|---|
| `url` | string, required | HTTP(S) URL, up to 8192 characters |

Pages larger than pi's default tool output limit (50KB / 2000 lines) are truncated for the model, and the full Markdown is saved to a temp file whose path is included in the result, so the agent can read the rest with its `read` tool.

## Behavior

- **Retries**: HTTP 408, 429 and 5xx are retried up to 3 attempts, honoring `Retry-After` or backing off exponentially. Other errors are reported to the model with the API's error message.
- **Cancellation**: requests follow the turn's abort signal, so pressing Esc stops them.
- **Permissions**: both tools are annotated `readOnlyHint: true, openWorldHint: true`, so permission extensions can treat them as non-destructive network reads.
- **Rendering**: compact call/result rendering in the TUI; expand a result to see all URLs.

## Pricing and limits

From the [DeepSeek docs](https://api-docs.deepseek.com/guides/search/) (check them for current numbers):

- $0.75 per 1,000 successful requests for each API; billing starts November 1, 2026 (Beijing time). Empty results and failed requests are not billed.
- Rate limits: Search 100 QPS, Fetch 25 QPS plus per-domain limits.

## Development

The extension is a single TypeScript file loaded by pi through jiti, so there is no build step:

```bash
pi -e ./extensions/index.ts
```

`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` and `typebox` are supplied by pi at runtime and declared as peer dependencies.

## License

[MIT](LICENSE)
