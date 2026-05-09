# LLM Token Proxy

Local HTTP proxy that sits between your tools (Claude Code, Claude Desktop, custom MCPs/agents, anything OpenAI- or Anthropic-compatible) and your upstream LLM provider, recording **every request** with model, token counts, estimated cost, latency, consumer, and (if your client cooperates) per-project tags.

**Why this exists:** the maintainer woke up to a $1600 Anthropic bill in 8 days with no idea what drove it. Cloud-provider dashboards aggregate at the org level; they can't tell you that *this CC session in that repo* spent $42 on a prompt-caching loop. A local proxy can.

## What it does

- **Multi-upstream routing.** Picks an upstream by API-key prefix — e.g. `sk-ant-` → `api.anthropic.com`, JWTs → your gateway (LiteLLM, RDsec AI Endpoint, custom).
- **Per-call accounting** in SQLite: consumer, model, upstream, input/output/cache tokens, estimated cost (USD), duration, HTTP status, optional `x-project` / `x-task` headers, user-agent.
- **Streaming-aware**: parses SSE `message_stop` / `message_delta` / OpenAI-style usage chunks to capture token counts on streamed responses.
- **Dashboard** at `/dashboard` for daily trends and totals.
- **Self-testing watchdog** runs on a systemd timer (default every 5 min) and sends a real Haiku call (~$0.000013) through the proxy with `Accept-Encoding: gzip, deflate, br` so it catches encoding regressions, auth misconfig, and upstream lockouts the moment they happen — not when your $1600 bill arrives.

## Quick start

```bash
git clone https://github.com/grobomo/llm-token-proxy.git
cd llm-token-proxy
npm install
cp config.example.yaml config.yaml
# edit config.yaml: set your upstreams, drop your real pricing if it differs
node proxy.js
```

Then point a client at it. For Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4100
claude
```

For OpenAI-compatible tools:

```python
client = OpenAI(base_url="http://127.0.0.1:4100/v1", api_key="<your-upstream-key>")
```

## Architecture

```
   Claude Code  ┐
   Claude Desktop├──► 127.0.0.1:4100  ──upstream by key prefix──►  api.anthropic.com
   MCPs / Agents┘         │                                        Your LiteLLM
   OpenAI clients         │                                        OpenAI / Bedrock / etc.
                          │
                          └──► usage.db  (SQLite)
                          └──► /dashboard
                          └──► /health  (cheap)
                          └──► watchdog: real e2e Haiku call w/ Accept-Encoding
```

## Per-project attribution

Out of the box the proxy attributes by **consumer** (sniffed from User-Agent: `claude-code`, `anthropic-sdk`, `openai-sdk`, …) and `X-Consumer` if the client sets one. To track *which project* a session was for, your client must send `X-Project: <repo-or-tag>` (and optionally `X-Task: <branch-or-ticket>`) on each request.

Stock Claude Code and Claude Desktop **do not** send these. The cleanest way is a tiny localhost shim on a different port that injects the headers based on cwd / git branch and forwards to `:4100`. PRs welcome.

## Files

| | |
|---|---|
| `proxy.js` | The Express + undici proxy. |
| `db.js` | SQLite schema + insert helpers. |
| `pricing.js` | Cost calc — pricing table comes from `config.yaml`. |
| `lib/cache-estimator.js` | Heuristic cache cost estimation for upstreams that strip cache tokens. |
| `lib/ask.js`, `lib/judge.js` | Tiered LLM endpoint handlers. |
| `lib/escalation.js` | Async escalation manager with polling and webhook support. |
| `dashboard/` | Static HTML + JSON API at `/dashboard` and `/api/*`. |
| `scripts/watchdog.sh` | End-to-end self-test. Generic; cooperates with consumer enforcers via hooks. |
| `scripts/backfill-cache-estimates.js` | Standalone cache estimation backfill for historical data. |
| `scripts/watchdog-ctl.sh` | Operator CLI: status, maintenance, disable/enable, tick, tail. |
| `scripts/cost-analyzer.js` | Rules-based pattern detection (model overuse, idle spend, etc.). |
| `scripts/cost-optimizer.js` | Suggestions based on the analyzer output. |
| `scripts/daily-digest.js` | Daily cost summary (log/Slack/webhook). |
| `scripts/*.service`, `*.timer` | systemd user units (adjust paths). |
| `config.example.yaml` | Example config — copy to `config.yaml`. |
| `watchdog.example.conf` | Example watchdog config — copy to `~/.config/llm-token-proxy/watchdog.conf`. |

## Watchdog

```bash
cp watchdog.example.conf ~/.config/llm-token-proxy/watchdog.conf
# edit: set TEST_API_KEY (or RUNTIME_ENV_FILE + TEST_API_KEY_VAR)

cp scripts/token-proxy-watchdog.{service,timer} ~/.config/systemd/user/
# edit ExecStart paths
systemctl --user daemon-reload
systemctl --user enable --now token-proxy-watchdog.timer

scripts/watchdog-ctl.sh status
```

Each tick: real chat-completion call with `Accept-Encoding: gzip, deflate, br` → curl `--compressed` validates decompression. State transitions (PASS→FAIL or FAIL→PASS) optionally invoke `WATCHDOG_ON_FAIL_HOOK` / `WATCHDOG_ON_PASS_HOOK` — point these at your own scripts to flip consumer configs (e.g. unset `ANTHROPIC_BASE_URL` while the proxy is down).

## Tiered LLM Endpoints

The proxy exposes tiered `/ask` and `/judge` endpoints for internal tooling (hooks, scripts, agents) to call LLMs at different capability levels through the same proxy with cost tracking.

| Endpoint | Model | Cost | Access |
|----------|-------|------|--------|
| `POST /ask` | Haiku (L1) | ~$0.001 | Public |
| `POST /ask/l2` | Sonnet (L2) | ~$0.01 | Localhost only, 100/hr |
| `POST /ask/l3` | Opus (L3) | ~$0.05 | Localhost only, 20/hr |
| `POST /judge` | Haiku (L1) | ~$0.001 | Public |
| `POST /judge/l2` | Sonnet (L2) | ~$0.01 | Localhost only, 50/hr |
| `POST /judge/l3` | Opus (L3) | ~$0.05 | Localhost only, 10/hr |

**Auto-escalation:** When `/ask` or `/judge` returns low confidence (< 0.7 in jsonMode), it automatically escalates to L2. Callers can choose sync (wait up to 8s) or async (get a poll URL back immediately).

**Escalation manager:** Tracks async escalations in `escalation_state` table. Poll `GET /escalation/:ticketId` for results. Per-tier audit notes written to `data/escalations/`.

Full API docs: [`docs/api-reference.md`](./docs/api-reference.md) | Escalation flow: [`docs/escalation-flow.md`](./docs/escalation-flow.md)

## Cache cost estimation

LiteLLM gateways (RDSec, etc.) strip `cache_creation_input_tokens` and `cache_read_input_tokens` from responses — reporting only non-cached input. This makes cache costs invisible (~$2-4/session for Opus).

The proxy detects this and applies heuristic estimation:
- **First call in a session:** estimates 60K cache_write tokens (system prompt being cached)
- **Subsequent calls:** estimates 200K cache_read tokens (system prompt read from cache)
- Only activates for Claude models on non-Anthropic upstreams with a valid session_id
- Skips estimation for single-turn calls (e.g. `/ask`, `/judge`) that don't use caching
- Tagged with `cache_estimated=1` in the DB so dashboard shows an `est` badge

The `/api/cache-estimation` endpoint shows actual vs estimated breakdown. The dashboard's Cache Economics panel reflects this data.

**Backfill:** For historical data logged before the estimator was deployed, `POST /api/backfill-cache` retroactively applies the heuristic. Localhost-only, dry-run by default (`{"dryRun": false}` to execute). Also available as `node scripts/backfill-cache-estimates.js [--dry-run]`.

## Dashboard

The dashboard at `/dashboard` shows:
- **Hourly spend** — stacked bar chart by model with hover details
- **Cost by model** — per-model breakdown with upstream labels (RDSec/Anthropic)
- **Cache economics** — estimated cache write/read tokens and costs
- **Top projects** — per-project cost with horizontal bar chart
- **Cost optimization** — session restart cost vs per-message context cost with break-even analysis
- **Judge decisions** — gate decision log (when using `/judge` endpoints)
- **Health** — proxy status + upstream reachability with auto-refresh

Failed calls (HTTP 4xx/5xx) are filtered from cost panels to reduce noise.

## Testing

```bash
npm test          # 60 tests — 13 cache-estimator unit + 47 e2e (mock upstream + real proxy)
```

## Known limitations / TODO

See [TODO.md](./TODO.md). Top of mind: Postgres storage backend for multi-host deployments.

## License

MIT.
