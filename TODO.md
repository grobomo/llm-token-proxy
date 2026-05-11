# TODO

## Session State (2026-05-10)

Published to https://github.com/grobomo/llm-token-proxy (public). All commits pushed through `569b7da`.
67 tests passing (+ 27 health tests against live proxy). Schema v6 active. DB at `~/.token-proxy/usage.db`.
tokentracker.click fully live — sync every 5 min. Digest, Excel export, uptime all deployed.
Proxy watchdog: `scripts/watchdog-win.js` — auto-restarts proxy via tmux in WSL. Starts at login via Startup folder VBS.
Settings route through proxy (`http://127.0.0.1:4100`). Switch script: `~/.claude/proxy/switch_llm_provider.py`.
Untagged calls: 41/24h from hook system (openai-sdk consumer via /v1/chat/completions) — no X-Project header. Expected behavior, not a bug.

### Completed this session (2026-05-10)
- **Excel export** — `GET /api/export-excel` on both proxy and deploy server. XLSX with embedded bar chart.
- **Deploy parity** — uptime endpoint, cache-estimation summary fix, cost-breakdown token columns.
- **DB merge + sync** — merged 7,129 remote + 416 local rows. Cron syncs every 5 min. Auto-reopen DB on mtime change.
- **Blueprint MCP fix** — changed servers.yaml from Windows node to WSL node. Server starts (31 tools). Chrome extension needs manual reload to connect.
- **Cost accuracy audit** — compared proxy vs RDSec billing (May 7-9):
  - RDSec: $1,010.83 for your usage. Proxy: $695.07 (after fix).
  - **Fixed**: double-charging cache tokens in pricing.js. Saved $24.91 on historical data.
  - **Remaining gap**: proxy captures fewer calls than RDSec (missing 81-1,109 traces/day). Some calls bypass proxy.
  - **Root cause**: `claude-4.6-opus` (Vertex AI) reports ~130K input_tokens but only 27K as cache_read — the rest are cache tokens not broken out by the upstream. Proxy can't fix what the upstream doesn't report.
- **Pricing config** — added all AWS/dated model variants.
- **Security** — filename sanitization, Secure cookie, .gitignore cleanup.
- **Test stability** — increased timeouts for WSL startup latency + exceljs cold-start.
- **Watchdog** — `scripts/watchdog-win.js` — Windows-native proxy auto-restart via tmux. T001 complete.

### Open priorities
- [ ] T111: Pluggable storage backend (Postgres) for multi-host deployments
- [~] T129: Blueprint MCP — server starts (WSL node fix), extension connects intermittently (WebSocket drops after enable). Earlier this session, successfully took screenshots and extracted RDSec billing data. Needs debugging in blueprint-extra project.
- [x] T130: Cost source-of-truth — root cause: `ANTHROPIC_BASE_URL` was pointing directly to RDSec, bypassing proxy. Fixed: settings now route through `http://127.0.0.1:4100`. RDSec upstream URL fixed to include `/v1` (was stripping path). Remaining gap: Vertex AI models don't break out cache tokens separately — proxy can't fix what upstream doesn't report.
- [ ] T136: Build gate to enforce "use mcp-manager for all MCP servers"
- [x] T140: Daily/weekly digest — `/api/digest?period=daily|weekly` returns styled HTML with spend stats, 7-day trend, model/project breakdown. Available on both proxy and tokentracker.click. Commit 553551e.

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
- [x] T126: Tiered judge endpoints — escalation for binary decisions (commit 6ca6c4b):

  **`POST /judge`** (L1 — Haiku, existing, public)
  Fast binary allow/block for gate decisions. Current behavior unchanged.
  Request: `{question, context, gate, project, fallback}`
  Response: `{allow, reason, confidence, tier: "L1"}`

  **`POST /judge/l2`** (L2 — Sonnet, internal only)
  When L1 confidence < 0.7 or gate involves security/destructive actions. Deeper reasoning on ambiguous scope, intent, or risk assessment.
  Request: same + `{escalation_reason, l1_response?}`
  Response: same + `{tier: "L2", escalated_from}`

  **`POST /judge/l3`** (L3 — Opus, internal only)
  Final arbiter for high-stakes blocks: destructive operations, security-critical gates, cross-project permission decisions. Only when L2 is split or stakes justify the cost.
  Request: same + `{escalation_reason, l2_response?}`
  Response: same + `{tier: "L3", escalated_from}`

  **Auto-escalation**: `/judge` returns confidence. If < 0.7, `_haiku-judge.js` helper auto-calls `/judge/l2`. If L2 confidence still < 0.7 AND gate is tagged `critical: true`, escalates to L3. Total chain cost logged.

  **Security**: L2/L3 bound to 127.0.0.1 only. Rate limit: L2 max 50/hour, L3 max 10/hour. All log to `judge_log` with `tier` column.

  **Escalation Manager** (applies to both T125 and T126):

  The escalation manager is an internal coordination layer that:

  1. **Immediate L1 response**: When L1 decides to escalate, it returns immediately to caller with `{status: "escalating", ticket_id: "esc-abc123", tier: "L1", message: "Low confidence (0.4) — escalating to L2 for deeper analysis. Will update shortly.", poll_url: "/escalation/esc-abc123"}`. Caller is NOT left hanging.

  2. **Background escalation**: Manager spawns L2 (or L3) call async. Tracks state in `escalation_state` table: `{ticket_id, caller, gate, tier_chain: ["L1","L2"], status: "pending|resolved|timeout", created_at, resolved_at, responses: []}`.

  3. **Per-tier session notes**: Each tier writes notes to `data/escalations/{ticket_id}-L1.md`, `{ticket_id}-L2.md`, etc. Contains: prompt received, reasoning, confidence, decision, and why it escalated (or didn't). Creates an audit trail for debugging judgment calls.

  4. **Polling + webhook**: Caller can poll `GET /escalation/{ticket_id}` for status. Optionally pass `webhook_url` in original request — manager POSTs final answer there when resolved. For sync callers (hooks), manager holds connection up to 8s then returns best-available answer with `{partial: true}` if L2/L3 hasn't responded yet.

  5. **Timeout guarantees**: L2 has 10s budget, L3 has 15s budget. If tier times out, manager returns the last-available tier's response (degraded but never hangs). Total max latency: 8s for sync callers, 25s for async.

  6. **State tracking**: `escalation_state` table tracks full lifecycle. Dashboard shows: active escalations, resolution rate per tier, avg escalation latency, timeout rate.

  **Tests** (for both T125 and T126):
  - Unit: each tier returns correct model/response format
  - Unit: external IP rejected for /l2 and /l3 (127.0.0.1 only)
  - Unit: rate limits enforced (429 after threshold)
  - Integration: L1 low-confidence auto-escalates to L2
  - Integration: L2 low-confidence + critical gate escalates to L3
  - Integration: escalation chain logged with cost attribution per tier
  - Integration: fallback behavior when higher tier unreachable (use lower tier's answer)
  - E2E: hook-runner `_haiku-judge.js` → `/judge` → confidence < 0.7 → `/judge/l2` → block returned to gate
  - Escalation manager: immediate "escalating" response returned to caller (not hanging)
  - Escalation manager: poll endpoint returns resolved answer after L2 completes
  - Escalation manager: timeout returns best-available answer with partial flag
  - Escalation manager: per-tier notes files created in data/escalations/
  - Escalation manager: webhook delivery on resolution
  - Escalation manager: state table tracks full lifecycle

  **Documentation** (for T125 + T126):
  - README section: "Tiered LLM Endpoints" — architecture diagram, endpoint reference, auth model, rate limits
  - README section: "Escalation Manager" — lifecycle flow, polling, webhook, timeout behavior
  - Inline JSDoc on each endpoint handler: params, response schema, escalation logic
  - `docs/escalation-flow.md` — sequence diagram (L1 → caller response → background L2 → poll/webhook → resolution)
  - `docs/api-reference.md` — OpenAPI-style reference for /ask, /ask/l2, /ask/l3, /judge, /judge/l2, /judge/l3, /escalation/{id}
  - Dashboard: info tooltip on escalation panel explaining what each metric means
  - Per-tier notes files are self-documenting (markdown with reasoning trace)

## High (Haiku /ask endpoint)

- [x] T125: Tiered LLM endpoints — internal escalation architecture (commit 51e4772):

  **`POST /ask`** (L1 — Haiku, $0.001/call, public)
  General-purpose Haiku caller. Fast, cheap, high-volume. Used by: L1 preprocessor, stop-analysis, gate judges, any hook needing quick structured output.
  Request: `{system, prompt, caller, maxTokens?, jsonMode?}`
  Response: `{ok, content, parsed?, ms, tokens, tier: "L1"}`

  **`POST /ask/l2`** (L2 — Sonnet, ~$0.01/call, internal only)
  For when L1 confidence is low or decision requires deeper reasoning. NOT exposed on public endpoint — only callable from L1 processes (localhost or via `X-Internal: true` header verified by IP). Use cases: ambiguous prompt interpretation, complex scope judgments, code review decisions.
  Request: same as /ask + `{escalation_reason}`
  Response: same + `{tier: "L2", escalated_from}`

  **`POST /ask/l3`** (L3 — Opus, ~$0.05/call, internal only)
  Critical thinking, high-stakes judgments. Only called when L2 is uncertain or stakes are high (security decisions, destructive action approval, architectural judgments). Same internal-only restriction.
  Request: same as /ask + `{escalation_reason, l2_response?}`
  Response: same + `{tier: "L3", escalated_from}`

  **Escalation pattern**: L1 calls include confidence score. If confidence < threshold, L1 process auto-escalates to L2. L2 can further escalate to L3. Each tier logs: caller, escalation_reason, which tier answered, total cost chain.

  **Security**: L2/L3 bound to 127.0.0.1 only. Public-facing proxy rejects /ask/l2 and /ask/l3 from external IPs. Rate limit: L2 max 100/hour, L3 max 20/hour.

  All tiers log to unified `ask_log` table with `tier` column for dashboard grouping.

## Medium (Dashboard UX)

- [x] T120: Renamed to "Token Tracker". Commit a5e2dc4.
- [x] T121: Health indicator UX overhaul (commit 957c7a2):
  1. RENAME: "Proxy unreachable" is misleading — if you can see the dashboard, the proxy is up. The label should say "API upstream" not "Proxy". Show "unreachable" only for upstream failures.
  2. HOVER DETAILS: Add tooltip showing: what failed (connection refused vs timeout vs HTTP error), error message, last successful check time, retry countdown (polls every 15s).
  3. STALENESS: Browser tabs throttle setInterval when backgrounded — health dot can show stale failure state. Add visual "stale" indicator (gray dot) if last check was >30s ago, and force-refresh on tab focus.
  4. SELF-AWARENESS: If the dashboard page loaded successfully, proxy is definitionally running. Show a separate "Proxy: running" indicator that's always green (it's a tautology but reduces user confusion).
- [x] T124: Cost optimization widget reframed — shows restart cost vs per-message context cost, break-even point (12 messages). Panel explains the tradeoff clearly.
- [x] T123: Upstream labels [RDsec]/[C4E] added to model names. Commit a5e2dc4.
- [x] T122: Added "(UTC)" label to today/yesterday header. Commit a5e2dc4. Full browser-timezone conversion is a future enhancement.

## Low / Backlog

- [x] T109: Response cache for dashboard API — 30s TTL, LRU eviction (lib/cache.js). X-Cache headers + /api/cache-stats endpoint. Full LLM request dedup not viable (all calls are unique conversations).
- [x] T110: 24h stability test — PASSED. 4 cycles, 32 checks, 0 failures. All endpoints healthy.
- [ ] T111: Pluggable storage backend (Postgres) for multi-host deployments.
- [x] T112: Pluggable alerting (Slack, webhook, email) — `lib/alert.js` implements log/slack/webhook. Wired into spike-detect.js. Config: `alerting.slack_webhook` + `alerting.webhook_url`. Set env vars or config.yaml to activate.
- [x] T113: Evaluated LiteLLM proxy — decided to keep custom proxy.js. LiteLLM lacks cache token tracking, hourly model charts, /judge endpoint, IP audit, model override rules. Our proxy has too much specialized tooling to replace. RDsec already uses LiteLLM upstream so we get its routing benefits without running it ourselves.
- [x] T116: Custom domain `tokentracker.click` — LIVE with HTTPS. Cert expires 2026-08-07 (auto-renews). Login: password-only → `proxy1`. Admin: `admin`/`4dm1n!`.

## Medium (Testing & Docs)

- [x] T126b: E2E test suite — `npm test` runs 67 tests via node:test. Mock upstream, real proxy process, real HTTP requests. Covers: health, diagnose, proxy pass-through, /ask L1/L2/L3, /judge L1/L2/L3, escalation, rate limits, all API endpoints, export, digest, streaming SSE. All pass.
- [x] T127: Docs audit — fixed auth section, added /v1/* proxy + /health + /diagnose docs, created `docs/escalation-flow.md`, added testing section to README.
- [x] T128: Streaming SSE e2e test — 2 new tests (SSE forwarding + upstream error). Total: 27 tests pass.

## Open Tasks
- [x] T001: Proxy watchdog service — `scripts/watchdog-win.js`. Node.js persistent process, checks health every 30s, auto-restarts proxy in WSL tmux after 3 failures. Supports `--install` (Task Scheduler), `--status`, `--remove`. Commit 728b659.
- [x] T002: Expose /ask endpoint — completed as part of T125 (tiered LLM endpoints). `/ask`, `/ask/l2`, `/ask/l3` all implemented.
