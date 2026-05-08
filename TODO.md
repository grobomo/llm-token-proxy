# TODO

## Session State (2026-05-08, end of session)

Published to https://github.com/grobomo/llm-token-proxy (public). All commits pushed through `ed496cb`.
`gh_auto` fixed: uses inline credential helper for git, active-account switch/restore for gh.
`gh-auto-gate` hook active in WSL — blocks raw `gh`/`git push`.

### Remaining Setup

- [ ] Create `grobomo/openclaw` (private) and push openclaw mirror. Prereqs: verify no customer data, user approved personal backup.
- [ ] Audit all clients for `ANTHROPIC_BASE_URL` pointing direct (bypassing proxy) — T100 remaining gap.

---

## Completed

- [x] **T100: Token cost mismatch investigation.** Resolved 2026-05-08. Proxy run rate ($218/d) reconciles with billing. Gaps: streaming parse failures (fixed T103) + stale example config (fixed).
- [x] **T101: zstd compression.** Strip from Accept-Encoding. Commit 12ad3e3.
- [x] **T103: Streaming usage parser.** Fixed cache double-counting + LiteLLM cost fallback. Commit 2575d0d.

## High

- [ ] **T102: Per-project header injection for stock clients.** Claude Code, Claude Desktop, and most MCPs do not send `X-Project` / `X-Task`. Without them, every CC session shows up as `consumer=claude-code` with no project. Options:
  - A localhost shim on a separate port that injects headers based on cwd / git branch.
  - A Claude Code hook that mutates outbound HTTP headers (if/when CC supports that).
  - A tiny PowerShell launcher for Windows CC that sets per-cwd env vars.
  - **Next step**: Investigate if Claude Code's `ANTHROPIC_BASE_URL` can include path segments or custom headers via env vars.

## Medium

- [x] T104: Spike detection / alerting. Implemented `scripts/spike-detect.js` (commit 4fe7adf). Compares today vs 7d rolling avg, exits 1 on spike, writes `~/.token-proxy-spike-alert`. **Remaining**: wire into cron (recommended: every 30 min).
- [ ] T105: Cost-report reconciliation script — diff Anthropic's `/v1/organizations/cost_report` against `usage.db` for the same window; report gaps. **Blocker**: need Anthropic admin API key with billing scope.
- [ ] T106: Data-driven consumer enforcement. Move stack-specific consumer rewrite logic into a generic mechanism configurable in `watchdog.conf`. **Depends on**: T102 (per-project headers).
- [ ] T107: Dashboard: spike chart, top-N expensive operations, per-project leaderboard. **Depends on**: T102.
- [ ] T108: Publish.json multi-account support — allow pushing to both grobomo (public) and tmemu (private backup). **Note**: stale tmemu pushurl was the original attempt at this; needs proper multi-remote design in `gh_auto`.

## Low / Backlog

- [ ] T109: Request dedup / cache layer (return cached identical-prompt responses without an upstream round-trip).
- [ ] T110: 24h stability test under realistic mixed load.
- [ ] T111: Pluggable storage backend (Postgres) for multi-host deployments.
- [ ] T112: Pluggable alerting (Slack, webhook, email) — `alert_channel` is wired in config but not implemented.
- [ ] T113: Consider replacing custom proxy.js with LiteLLM proxy (same tech RDsec runs upstream). Battle-tested streaming/compression. Keep if per-project attribution is preserved.
