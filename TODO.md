# TODO

## Session State (2026-05-08)

Code is committed locally (`0d0ddcb`). Pushed to `joel-ginsberg_tmemu/llm-token-proxy` (private, works). NOT yet on grobomo (public) — blocked by auth.

### Immediate Blockers

- [x] **FIX: grobomo gh keyring token authenticates as joel-ginsberg_tmemu (EMU).**
  **Root cause (2026-05-08):** `gh` v2.57+ ignores `GH_TOKEN` env var when keyring auth is active — it always uses the "active account." `gh_auto` was setting `GH_TOKEN` correctly but `gh` didn't care.
  **Fix applied:** Updated `gh_auto` to run `gh auth switch --user $ACCOUNT` before each command.
- [x] **FIX: `gh_auto repo create --source=. --push` says "not a git repository" even after `git init`.**
  Workaround used: create repo via API (`gh_auto api user/repos -X POST`), then `gh_auto push`.
- [x] **CLEANUP: delete accidental `joel-ginsberg_tmemu/llm-token-proxy` repo** — repo does not exist (404); either never created successfully or already deleted.

### Immediate Tasks

- [x] Create `grobomo/llm-token-proxy` (public, empty) on GitHub — done 2026-05-08
- [x] `gh_auto push origin main` — pushed commit 18b556c
- [x] Trigger secret-scan GitHub Action on push; verify passes — conclusion: success
- [x] Set up git local config: `user.name=grobomo`, `user.email=grobomo@users.noreply.github.com`
- [ ] Also create `grobomo/openclaw` (private) and push openclaw mirror (no customer data found; Teams team_ids are TM-internal but not customer data — user approved for personal portable backup)

---

## TOP PRIORITY — Open Mystery

- [ ] **T100: Token cost mismatch investigation.** Anthropic billing showed $1600 over 8 days while the proxy + provider headers told a much smaller story. Multiple Trend colleagues report the same trend this month. Goal: reconcile every billed dollar with proxy-recorded calls and identify the gap. Hypotheses to test:
  - [ ] Streaming-only path miscount — `[SSE done]` lines that show `out=N cost=$X` where X is much higher than `pricing × tokens` (one observed call: 17 output tokens → $0.06, ~100× expected). Check `pricing.js` cache_creation/cache_read accounting.
  - [ ] Calls bypassing the proxy entirely (some MCP server, some IDE extension, some script using a stale `ANTHROPIC_BASE_URL`).
  - [ ] Anthropic-side prompt-caching being charged at write-rate when we expected read-rate.
  - [ ] Model substitution at the gateway — caller asks for Sonnet, gateway routes to Opus.
  - [ ] Reconcile with Anthropic's `/v1/organizations/cost_report` endpoint and the LiteLLM `x-litellm-response-cost` headers we already log.

## High

- [x] **T101: zstd compression support.** Stripped `zstd` from forwarded `Accept-Encoding` so upstream picks gzip/br. Committed 12ad3e3.
- [ ] **T102: Per-project header injection for stock clients.** Claude Code, Claude Desktop, and most MCPs do not send `X-Project` / `X-Task`. Without them, every CC session shows up as `consumer=claude-code` with no project. Options:
  - A localhost shim on a separate port that injects headers based on cwd / git branch.
  - A Claude Code hook that mutates outbound HTTP headers (if/when CC supports that).
  - A tiny PowerShell launcher for Windows CC that sets per-cwd env vars.
- [x] **T103: Fix proxy.js streaming usage parser.** Fixed OpenAI-compat cache token math + LiteLLM cost header fallback. Committed 2575d0d.

## Medium

- [ ] T104: Spike detection / alerting. Dashboard shows trends but nothing fires when daily spend jumps >Nx 7-day average.
- [ ] T105: Cost-report reconciliation script — diff Anthropic's `/v1/organizations/cost_report` against `usage.db` for the same window; report gaps.
- [ ] T106: Data-driven consumer enforcement. Move stack-specific consumer rewrite logic (e.g. flipping `ANTHROPIC_BASE_URL` between proxy and direct in client settings.json files) from external scripts into a generic mechanism configurable in `watchdog.conf`.
- [ ] T107: Dashboard: spike chart, top-N expensive operations, per-project leaderboard once T102 lands.
- [ ] T108: Publish.json multi-account support — allow pushing to both grobomo (public) and tmemu (private backup) from one `git push origin`.

## Low / Backlog

- [ ] T109: Request dedup / cache layer (return cached identical-prompt responses without an upstream round-trip).
- [ ] T110: 24h stability test under realistic mixed load.
- [ ] T111: Pluggable storage backend (Postgres) for multi-host deployments.
- [ ] T112: Pluggable alerting (Slack, webhook, email) — `alert_channel` is wired in config but not implemented.
- [ ] T113: Consider replacing custom proxy.js with LiteLLM proxy (same tech RDsec runs upstream). Battle-tested streaming/compression. Keep if per-project attribution is preserved.
