# TODO

## Session State (2026-05-08, end of session)

Published to https://github.com/grobomo/llm-token-proxy (public). All commits pushed through `c5e6b86`.
`gh_auto` fixed: uses inline credential helper for git, active-account switch/restore for gh.
`gh-auto-gate` hook active in WSL — blocks raw `gh`/`git push`.
14 projects auto-configured with `X-Project` headers via `scripts/setup-projects.js`.

### Remaining Setup

- [ ] **Restart the running proxy** to load new code (schema v4, X-Project/session_id capture). Until restarted, all calls log `project=null`.
- [ ] Create `grobomo/openclaw` (private) and push openclaw mirror. Prereqs: verify no customer data, user approved personal backup.
- [ ] Audit all clients for `ANTHROPIC_BASE_URL` pointing direct (bypassing proxy) — T100 remaining gap.

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
- [ ] T106: Data-driven consumer enforcement. Move stack-specific consumer rewrite logic into a generic mechanism configurable in `watchdog.conf`. **Unblocked** — T102 complete, per-project data now flowing.
- [ ] T107: Dashboard: spike chart, top-N expensive operations, per-project leaderboard. **Unblocked** — T102 complete, per-project data now flowing.
- [ ] T108: Publish.json multi-account support — allow pushing to both grobomo (public) and tmemu (private backup). **Blocked**: pending grobomo/openclaw setup + tmemu scope audit.

## Low / Backlog

- [ ] T109: Request dedup / cache layer (return cached identical-prompt responses without an upstream round-trip).
- [ ] T110: 24h stability test under realistic mixed load.
- [ ] T111: Pluggable storage backend (Postgres) for multi-host deployments.
- [ ] T112: Pluggable alerting (Slack, webhook, email) — `alert_channel` is wired in config but not implemented.
- [ ] T113: Consider replacing custom proxy.js with LiteLLM proxy (same tech RDsec runs upstream). Battle-tested streaming/compression. Keep if per-project attribution is preserved.
