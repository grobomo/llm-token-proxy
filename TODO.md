# TODO

## Session State (2026-05-09 01:25 UTC)

Published to https://github.com/grobomo/llm-token-proxy (public). All commits pushed through `4a657c2`.
Schema v5 active (original_model column). Model override infrastructure deployed but no active rules.
Dashboard enhanced: cost-by-model + cache economics panels. Headless chromium screenshots work.
14 projects auto-configured with X-Project headers — confirmed populating in usage.db.
All systemd timers active: spike-detect (30min), watchdog (5min), daily-report (23:47), onedrive-sync (23:50), log-rotate (03:03).

### Next session priorities
- [x] Visually verify dashboard — confirmed via `chromium-browser --headless --no-sandbox`. Bars have varied heights, color-coded (blue/yellow/red). Pie data flows via API.
- [x] Verify per-project X-Project headers are populating in usage.db — confirmed working. 14 projects configured; new sessions tagged. Only pre-config sessions untagged.
- [x] Browser control: `chromium-browser --headless --no-sandbox --screenshot=<path>` works from WSL. No need for Blueprint MCP or PowerShell.

### Completed this session (not in code — system config)
- [x] Fixed proxy-restart-gate false positives (narrowed to only block token-proxy.service restart)
- [x] Added suggest-context-reset stop-hook rule (priority above todo-awareness)
- [x] Updated session-start-instructions: context-reset is autonomous, don't ask user
- [x] Installed persistent systemd timers (daily-report, onedrive-sync, log-rotate)
- [x] gh-auto-gate hook enabled in WSL

### Remaining Setup

- [x] **Restart the running proxy** — deployed via `safe-restart.sh`, schema v4 active, e2e verified.
- [x] Create `grobomo/openclaw` (private) and push openclaw mirror — all 14 branches pushed. Added `.github/publish.json`.
- [x] Audit all clients for `ANTHROPIC_BASE_URL` pointing direct — no active bypasses found. Only archived backups reference direct URLs.

---

## Completed

- [x] **T100: Token cost mismatch investigation.** Resolved 2026-05-08. Proxy run rate ($218/d) reconciles with billing. Gaps: streaming parse failures (fixed T103) + stale example config (fixed).
- [x] **T101: zstd compression.** Strip from Accept-Encoding. Commit 12ad3e3.
- [x] **T103: Streaming usage parser.** Fixed cache double-counting + LiteLLM cost fallback. Commit 2575d0d.

## High

- [x] **T102: Per-project header injection.** Solution: `ANTHROPIC_CUSTOM_HEADERS` env var in `.claude/settings.json`. Proxy captures `X-Project` + `X-Claude-Code-Session-Id`. Schema v4 adds `session_id` column. Commit f7f8b8e. Auto-setup script (c5e6b86) configured 14 projects.

## Medium

- [x] T104: Spike detection / alerting. `scripts/spike-detect.js` (commit 4fe7adf). Compares today vs 7d rolling avg, exits 1 on spike, writes `~/.token-proxy-spike-alert`. Systemd timer runs every 30 min.
- [x] T105: Cost-report reconciliation script. `scripts/reconcile-costs.js` — accepts `--report <file>` or `--api` with `ANTHROPIC_ADMIN_KEY`. Commit f73bd84.
- [x] T106: Data-driven consumer enforcement. `scripts/enforce-routing.js` — flags high cache_write consumers, untagged projects, unknown consumers. Commit 6177ae0. Key finding: upstream (anthropic vs rdsec) does NOT affect cost — same model = same price. Primary cost driver is cache_write volume per session start ($18.75/M).
- [x] T107: Dashboard: spike chart + top-N expensive operations. Commit ed48545. Hourly spend bar chart + top 8 costly calls table. Per-project leaderboard already existed from initial dashboard.
- [x] T108: Publish.json multi-account support. `gh_auto push-all` iterates `targets[]` array in publish.json, auto-creates remotes, pushes with per-account tokens. This repo configured for grobomo (public) + tmemu (private backup). Commit c38f94f.

## Medium (New)

- [x] T114: Cost optimization — analysis complete, behavioral change deployed:
  - Dashboard shows model breakdown + cache economics for ongoing visibility.
  - Model override infrastructure ready (no safe targets identified).
  - Context-reset rule tightened: requires 2+ staleness signals (not just "long session"). Should reduce restarts from ~12/day to ~6-8/day, saving ~$10-14/day.
  - Remaining savings require architectural changes (session persistence, compaction) — out of scope for now.
- [x] T115: Per-project hourly bar chart — dashboard already shows per-project pie on hover via `/api/hourly-breakdown`. 83 projects now tagged (14 WSL + 69 Windows). Data flowing: llm-token-proxy (779 calls/24h).

## Medium (API Retry Integration)

- [x] T117: Client diagnostics via `/diagnose` endpoint. Checks all upstreams individually, returns per-upstream status + actionable recommendation. Stop rule `14-api-error-diagnose` prompts model to call it on API errors. Watchdog already runs every 5 min. No need to bundle api_check.py — proxy IS the diagnostic layer.

## High (New — Haiku Judge Service)

- [x] T118: `POST /judge` endpoint — calls Haiku for semantic gate decisions, logs to `judge_log` table. `GET /api/judge-stats` for monitoring. Fallback support when Haiku unreachable.
- [x] T119: `GET /api/judge-stats` — included in T118 implementation. Dashboard panel pending (next session).

## Medium (Dashboard UX)

- [ ] T120: Rename top-left title from "token proxy" to "token proxy dashboard"
- [ ] T121: Health indicator UX overhaul:
  1. RENAME: "Proxy unreachable" is misleading — if you can see the dashboard, the proxy is up. The label should say "API upstream" not "Proxy". Show "unreachable" only for upstream failures.
  2. HOVER DETAILS: Add tooltip showing: what failed (connection refused vs timeout vs HTTP error), error message, last successful check time, retry countdown (polls every 15s).
  3. STALENESS: Browser tabs throttle setInterval when backgrounded — health dot can show stale failure state. Add visual "stale" indicator (gray dot) if last check was >30s ago, and force-refresh on tab focus.
  4. SELF-AWARENESS: If the dashboard page loaded successfully, proxy is definitionally running. Show a separate "Proxy: running" indicator that's always green (it's a tautology but reduces user confusion).
- [ ] T124: Cost optimization widget — reframe as tradeoff, not just "fewer restarts = savings". Current framing is misleading. The real economics: restarts cost $2.33 (cache_write) BUT reset context size. Longer sessions accumulate context → higher cache_read cost per message ($0.30/M tokens). Show: (1) avg context size at restart time, (2) per-message cost at current context size vs fresh, (3) break-even point (after N messages, smaller context saves more than the restart cost). Add info icon with the formula.
- [ ] T123: Cost-by-model widget — add upstream labels. Models with `-aws` suffix route through RDsec (Bedrock), others through C4E (direct Anthropic). Show as badge/tag next to model name: "[RDsec]" or "[C4E]". Data already has this info in the model name — just needs UI treatment.
- [ ] T122: Dashboard timezone bug — "today/yesterday" uses UTC but user is CDT (UTC-5). This makes "today" show only 5 hours of spending at 11pm local, which looks wrong vs the hourly bars. Fix: either display in local timezone (detect from browser) or clearly label "UTC" on all time references. The $132 vs "$50-60/hour" confusion is because only 2 high-spend hours exist in the UTC "today" window — user's actual workday is split across two UTC days.

## Low / Backlog

- [x] T109: Response cache for dashboard API — 30s TTL, LRU eviction (lib/cache.js). X-Cache headers + /api/cache-stats endpoint. Full LLM request dedup not viable (all calls are unique conversations).
- [x] T110: 24h stability test — PASSED. 4 cycles, 32 checks, 0 failures. All endpoints healthy.
- [ ] T111: Pluggable storage backend (Postgres) for multi-host deployments.
- [x] T112: Pluggable alerting (Slack, webhook, email) — `lib/alert.js` implements log/slack/webhook. Wired into spike-detect.js. Config: `alerting.slack_webhook` + `alerting.webhook_url`. Set env vars or config.yaml to activate.
- [x] T113: Evaluated LiteLLM proxy — decided to keep custom proxy.js. LiteLLM lacks cache token tracking, hourly model charts, /judge endpoint, IP audit, model override rules. Our proxy has too much specialized tooling to replace. RDsec already uses LiteLLM upstream so we get its routing benefits without running it ourselves.
- [x] T116: Custom domain `tokentracker.click` — LIVE with HTTPS. Cert expires 2026-08-07 (auto-renews). Login: password-only → `proxy1`. Admin: `admin`/`4dm1n!`.
