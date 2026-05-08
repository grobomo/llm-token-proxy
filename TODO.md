# TODO

## TOP PRIORITY — Open Mystery

- [ ] **T100: Token cost mismatch investigation.** Anthropic billing showed $1600 over 8 days while the proxy + provider headers told a much smaller story. Multiple Trend colleagues report the same trend this month. Goal: reconcile every billed dollar with proxy-recorded calls and identify the gap. Hypotheses to test:
  - [ ] Streaming-only path miscount — `[SSE done]` lines that show `out=N cost=$X` where X is much higher than `pricing × tokens` (one observed call: 17 output tokens → $0.06, ~100× expected). Check `pricing.js` cache_creation/cache_read accounting.
  - [ ] Calls bypassing the proxy entirely (some MCP server, some IDE extension, some script using a stale `ANTHROPIC_BASE_URL`).
  - [ ] Anthropic-side prompt-caching being charged at write-rate when we expected read-rate.
  - [ ] Model substitution at the gateway — caller asks for Sonnet, gateway routes to Opus.
  - [ ] Reconcile with Anthropic's `/v1/organizations/cost_report` endpoint and the LiteLLM `x-litellm-response-cost` headers we already log.

## High

- [ ] **T101: zstd compression support.** Claude Code Windows sends `Accept-Encoding: gzip, deflate, br, zstd`. Today neither undici nor curl `--compressed` decode zstd. If api.anthropic.com ever serves zstd, the proxy will pass it through with broken header semantics (or just fail). Either:
  - Strip `zstd` from the forwarded `Accept-Encoding` so upstream picks gzip/br, OR
  - Add zstd decompression on the proxy side.
- [ ] **T102: Per-project header injection for stock clients.** Claude Code, Claude Desktop, and most MCPs do not send `X-Project` / `X-Task`. Without them, every CC session shows up as `consumer=claude-code` with no project. Options:
  - A localhost shim on a separate port that injects headers based on cwd / git branch.
  - A Claude Code hook that mutates outbound HTTP headers (if/when CC supports that).
  - A tiny PowerShell launcher for Windows CC that sets per-cwd env vars.

## Medium

- [ ] T103: Spike detection / alerting. Right now the dashboard shows trends but nothing fires when daily spend jumps >Nx 7-day average.
- [ ] T104: Cost-report reconciliation script — diff Anthropic's `/v1/organizations/cost_report` against `usage.db` for the same window; report gaps.
- [ ] T105: Data-driven consumer enforcement. Move stack-specific consumer rewrite logic (e.g. flipping `ANTHROPIC_BASE_URL` between proxy and direct in client settings.json files) from external scripts into a generic mechanism configurable in `watchdog.conf`.
- [ ] T106: Streaming usage parser — handle every variant of the OpenAI vs. Anthropic streaming shape (we miss some today, evidenced by `in=undefined out=undefined cost=$0` lines).
- [ ] T107: Dashboard: spike chart, top-N expensive operations, per-project leaderboard once T102 lands.

## Low / Backlog

- [ ] T108: Request dedup / cache layer (return cached identical-prompt responses without an upstream round-trip).
- [ ] T109: 24h stability test under realistic mixed load.
- [ ] T110: Pluggable storage backend (Postgres) for multi-host deployments.
- [ ] T111: Pluggable alerting (Slack, webhook, email) — `alert_channel` is wired in config but not implemented.
