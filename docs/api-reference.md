# API Reference — Tiered LLM Endpoints

Base URL: `http://127.0.0.1:4100`

## Authentication

All endpoints require an API key via `x-api-key` header or `Authorization: Bearer <key>`.

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
