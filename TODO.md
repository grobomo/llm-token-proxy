# TODO

## Session State (2026-05-09 00:10 UTC)

Published to https://github.com/grobomo/llm-token-proxy (public). All commits pushed through `004251f`.
`gh_auto` fixed: inline credential helper for git, active-account switch/restore for gh.
`gh-auto-gate` + `proxy-restart-gate` hooks active (gate narrowed to only block proxy service restart).
14 projects auto-configured with `X-Project` headers. Proxy restarted with schema v4.
Daily cron/timers: spike-detect (30min), daily-report (23:47), onedrive-sync (23:50), log-rotate (03:03). All with `Persistent=true`.
`grobomo/openclaw` (private) pushed. `joel-ginsberg_tmemu/chat-exports` (private) pushed.

### Next session priorities
- [ ] T107: Dashboard spike chart + per-project leaderboard (unblocked, per-project data accumulating)
- [ ] Split stop-analysis-rules.yaml into numbered files (03-suggest-context-reset.yaml etc)
- [ ] Verify per-project X-Project headers are populating in usage.db after overnight accumulation

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

- [x] T104: Spike detection / alerting. Implemented `scripts/spike-detect.js` (commit 4fe7adf). Compares today vs 7d rolling avg, exits 1 on spike, writes `~/.token-proxy-spike-alert`. **Remaining**: wire into cron (recommended: every 30 min).
- [x] T105: Cost-report reconciliation script. `scripts/reconcile-costs.js` — accepts `--report <file>` or `--api` with `ANTHROPIC_ADMIN_KEY`. Commit f73bd84.
- [x] T106: Data-driven consumer enforcement. `scripts/enforce-routing.js` — flags high cache_write consumers, untagged projects, unknown consumers. Commit 6177ae0. Key finding: upstream (anthropic vs rdsec) does NOT affect cost — same model = same price. Primary cost driver is cache_write volume per session start ($18.75/M).
- [ ] T107: Dashboard: spike chart, top-N expensive operations, per-project leaderboard. **Unblocked** — T102 complete, per-project data now flowing. Ready to start.
- [ ] T108: Publish.json multi-account support — allow pushing to both grobomo (public) and tmemu (private backup). **Blocked**: pending grobomo/openclaw setup + tmemu scope audit.

## Medium (New)

- [ ] T114: Cost optimization — reduce daily spend from $189/day. Opportunities:
  - Fewer session restarts → save $10-20/day on cache_write ($18.75/M)
  - Route routine tasks to Sonnet ($3/$15) instead of Opus ($15/$75) → save $50-80/day
  - Session persistence / longer sessions → fewer fresh cache writes
  - Tracked in `scripts/enforce-routing.js` findings

## Low / Backlog

- [ ] T109: Request dedup / cache layer (return cached identical-prompt responses without an upstream round-trip).
- [ ] T110: 24h stability test under realistic mixed load.
- [ ] T111: Pluggable storage backend (Postgres) for multi-host deployments.
- [ ] T112: Pluggable alerting (Slack, webhook, email) — `alert_channel` is wired in config but not implemented.
- [ ] T113: Consider replacing custom proxy.js with LiteLLM proxy (same tech RDsec runs upstream). Battle-tested streaming/compression. Keep if per-project attribution is preserved.
