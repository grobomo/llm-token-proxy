# API Reference — Tiered LLM Endpoints

Base URL: `http://127.0.0.1:4100`

## Authentication

Tiered LLM endpoints (`/ask*`, `/judge*`) and the proxy path (`/v1/*`) require an API key via `x-api-key` header or `Authorization: Bearer <key>`.

Public endpoints (no auth): `/health`, `/diagnose`, `/escalation/:ticketId`, `/api/ask-stats`, `/api/judge-stats`, `/dashboard`.

## Configuration

The proxy reads `config.yaml` from the project root by default. Override with the `PROXY_CONFIG` env var:

```bash
PROXY_CONFIG=/path/to/config.yaml node proxy.js
```

## POST /ask

General-purpose LLM call (L1 — Haiku, ~$0.001/call). Public.

**Request:**
```json
{
  "system": "optional system prompt",
  "prompt": "required — the question/instruction",
  "caller": "identifier for the calling system",
  "maxTokens": 1024,
  "jsonMode": false,
  "sync": false,
  "webhook_url": "http://..."
}
```

- `jsonMode`: if true, attempts to parse JSON from response and extracts `confidence` field for auto-escalation
- `sync`: if true and escalation triggers, waits up to 8s for L2 instead of returning immediately
- `webhook_url`: receives POST with resolved escalation when background L2 completes

**Response (normal):**
```json
{
  "ok": true,
  "content": "text response",
  "parsed": null,
  "ms": 450,
  "tokens": { "in": 200, "out": 150 },
  "tier": "L1",
  "confidence": null
}
```

**Response (escalating, async):**
```json
{
  "status": "escalating",
  "ticket_id": "esc-abc123def456",
  "tier": "L1",
  "message": "Low confidence (0.4) — escalating to L2",
  "poll_url": "/escalation/esc-abc123def456",
  "l1_response": { "ok": true, "content": "...", ... }
}
```

**Response (escalating, sync):**
Returns L2 result directly with `escalated_from: "L1"` and `ticket_id`.

## POST /ask/l2

L2 — Sonnet (~$0.01/call). **Internal only** (127.0.0.1). Rate limit: 100/hour.

**Request:** Same as `/ask` plus:
```json
{
  "escalation_reason": "L1 confidence 0.4",
  "escalated_from": "L1"
}
```

**Response:** Same as `/ask` plus `remaining_quota`.

## POST /ask/l3

L3 — Opus (~$0.05/call). **Internal only** (127.0.0.1). Rate limit: 20/hour.

**Request/Response:** Same as `/ask/l2`.

## POST /judge

Semantic gate decisions (L1 — Haiku). Public. Auto-escalates when confidence < 0.7.

**Request:**
```json
{
  "question": "Should this operation be allowed?",
  "context": "optional additional context",
  "gate": "gate-name (required)",
  "project": "project-name",
  "session_id": "session identifier",
  "fallback": true,
  "sync": false,
  "critical": false,
  "webhook_url": "http://..."
}
```

- `fallback`: if LLM fails to respond, use this as the default decision
- `sync`: wait up to 8s for L2 escalation if confidence < 0.7
- `critical`: (reserved) marks gate for potential L3 escalation

**Response (high confidence):**
```json
{
  "allow": true,
  "reason": "one sentence explanation",
  "confidence": 0.95,
  "latency_ms": 800,
  "tier": "L1",
  "fallback_used": false
}
```

**Response (low confidence, async escalation):**
```json
{
  "allow": false,
  "reason": "...",
  "confidence": 0.4,
  "latency_ms": 1200,
  "tier": "L1",
  "fallback_used": false,
  "escalation": {
    "status": "escalating",
    "ticket_id": "esc-abc123",
    "poll_url": "/escalation/esc-abc123"
  }
}
```

**Response (low confidence, sync):**
Returns L2 decision directly with `tier: "L2"`, `escalated_from: "L1"`, `ticket_id`.

## POST /judge/l2

L2 judge — Sonnet. **Internal only** (127.0.0.1). Rate limit: 50/hour.

**Request:** Same as `/judge` plus `escalation_reason`, `escalated_from`.

**Response:** Same as `/judge` plus `remaining_quota`.

## POST /judge/l3

L3 judge — Opus. **Internal only** (127.0.0.1). Rate limit: 10/hour.

**Request/Response:** Same as `/judge/l2`.

## GET /escalation/:ticketId

Poll escalation status. No auth required.

**Response:**
```json
{
  "ticket_id": "esc-abc123",
  "caller": "judge-branch-push",
  "gate": "branch-push",
  "tier_chain": ["L1", "L2"],
  "status": "resolved",
  "responses": [
    { "tier": "L1", "ok": true, "content": "...", "confidence": 0.4 },
    { "tier": "L2", "ok": true, "content": "...", "confidence": 0.85 }
  ],
  "created_at": "2026-05-09T05:29:35.737Z",
  "resolved_at": "2026-05-09T05:29:37.946Z"
}
```

Status values: `pending`, `resolved`, `timeout`.

## GET /api/ask-stats

Dashboard stats for /ask endpoints (last 24h). Groups by tier + caller.

## GET /api/judge-stats

Dashboard stats for /judge endpoints (last 24h). Groups by gate + tier.

## Rate Limits

| Endpoint | Limit | Scope |
|----------|-------|-------|
| /ask | unlimited | — |
| /ask/l2 | 100/hour | per-instance |
| /ask/l3 | 20/hour | per-instance |
| /judge | unlimited | — |
| /judge/l2 | 50/hour | per-instance |
| /judge/l3 | 10/hour | per-instance |

Rate limit exceeded returns `429`:
```json
{ "error": "rate_limited", "remaining": 0, "reset_at": "ISO-8601" }
```

## Security Model

- `/ask` and `/judge` (L1): accessible from any IP with valid API key
- `/ask/l2`, `/ask/l3`, `/judge/l2`, `/judge/l3`: localhost only (127.0.0.1, ::1)
- External IPs receive `403 { "error": "internal_only" }`

## Escalation Flow

```
Client → POST /ask (or /judge)
         ↓
    L1 responds with confidence
         ↓
    confidence >= 0.7? → return L1 result
         ↓ (< 0.7)
    sync: true?
      YES → wait up to 8s for L2, return L2 result (or L1 if timeout)
      NO  → return immediately with poll_url, spawn background L2
              ↓
         L2 completes → resolves escalation → webhook fires (if configured)
              ↓
         Client polls GET /escalation/:id → gets L2 result
```

## Per-tier Audit Notes

Each escalation writes markdown notes to `data/escalations/{ticket_id}-L{n}.md` containing:
- Prompt received
- Response content
- Confidence score
- Latency and token counts

## Proxy Pass-through: /v1/*

All requests to `/v1/*` are forwarded to the matching upstream based on API key prefix (configured in `config.yaml` under `upstreams`).

**Routing:** The proxy matches the API key's prefix against `key_pattern` entries. First match wins.

**Error responses:**

| Status | Error | Cause |
|--------|-------|-------|
| 400 | `no_upstream_match` | API key prefix doesn't match any configured upstream |
| 502 | `upstream_unreachable` | Upstream server is down or timed out |
| 503 | `shutting_down` | Proxy is draining connections (includes `Retry-After: 2` header) |

**Usage logging:** Every proxied request logs token usage and cost to SQLite. Streaming responses (SSE) are parsed for usage data in `message_delta` / `message_stop` events.

## Dashboard API

All dashboard endpoints are public (no auth). Most accept a `?range=` parameter: `1h`, `6h`, `12h`, `24h` (default), `7d`, `30d`.

### GET /api/

Self-documenting endpoint index. Returns all available endpoints with descriptions and parameters.

### GET /api/summary

All dashboard data in one request: totals, by-consumer, by-model, by-project, by-task. Accepts `?period=today|7d|30d|all`.

### GET /api/sessions

Per-session cost analytics. Groups by `session_id` (from Claude Code's `X-Claude-Code-Session-Id` header).

```json
{
  "sessions": [
    { "session_id": "abc...", "project": "my-project", "calls": 48, "cost": 17.25, "duration_min": 45.2, "models": ["claude-4.6-opus-aws"] }
  ],
  "total_cost": 17.25,
  "session_count": 1
}
```

### GET /api/export

Downloads usage data as CSV. Opens as a file download in the browser.

`GET /api/export?range=7d` → `token-usage-7d-2026-05-09.csv`

### GET /api/hourly-breakdown

Hourly spend with model + project breakdown per hour. Used by the stacked bar chart.

### GET /api/cost-breakdown

Model-level cost breakdown with cache economics (cache_read, cache_write, estimated vs actual).

### GET /api/project-costs

Top 10 projects by cost. Excludes failed calls (HTTP 4xx/5xx).

### GET /api/savings-potential

Cost optimization levers: session restart count, cache write cost, savings per fewer restart.

### GET /api/daily-comparison

Today's spend vs yesterday. Accepts `?tz_offset=<minutes>` for timezone adjustment.

### GET /api/cache-stats

Response cache hit/miss statistics. Bypasses the cache itself.

## GET /health

No auth required. Returns proxy and upstream status.

```json
{
  "status": "ok",
  "upstream": "reachable",
  "upstreams": ["anthropic"],
  "proxy": "running",
  "port": 4100,
  "ts": "ISO-8601"
}
```

Returns 503 with `"status": "degraded"` if the primary upstream is unreachable.

## GET /diagnose

No auth required. Checks all configured upstreams individually.

```json
{
  "cause": "healthy",
  "proxy": true,
  "upstreams": { "anthropic": "reachable" },
  "action": "No action needed",
  "ts": "ISO-8601"
}
```
