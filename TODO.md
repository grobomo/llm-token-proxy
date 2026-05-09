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
- [ ] T115: Per-project hourly bar chart — waiting for more projects to produce tagged data. Only `llm-token-proxy` tagged so far.

## Low / Backlog

- [ ] T109: Request dedup / cache layer (return cached identical-prompt responses without an upstream round-trip).
- [ ] T110: 24h stability test under realistic mixed load.
- [ ] T111: Pluggable storage backend (Postgres) for multi-host deployments.
- [ ] T112: Pluggable alerting (Slack, webhook, email) — `alert_channel` is wired in config but not implemented.
- [ ] T113: Consider replacing custom proxy.js with LiteLLM proxy (same tech RDsec runs upstream). Battle-tested streaming/compression. Keep if per-project attribution is preserved.
- [ ] T116: Custom domain for dashboard — `tokentracker.click` available via Route53 ($3/year). Currently served at `ec2-54-160-207-89.compute-1.amazonaws.com`. Registration + A record + optional HTTPS (Let's Encrypt) when ready.
