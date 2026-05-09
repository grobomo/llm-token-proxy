# Escalation Flow

## Sequence Diagram

```
┌────────┐       ┌───────────┐       ┌──────────────────┐       ┌──────────┐
│ Caller │       │ Proxy L1  │       │ Escalation Mgr   │       │ Proxy L2 │
└───┬────┘       └─────┬─────┘       └────────┬─────────┘       └────┬─────┘
    │                   │                      │                      │
    │  POST /ask or     │                      │                      │
    │  POST /judge      │                      │                      │
    │──────────────────>│                      │                      │
    │                   │                      │                      │
    │                   │  call Haiku (L1)     │                      │
    │                   │─────────────────────────────────────────────>│ (via /v1/messages)
    │                   │<─────────────────────────────────────────────│
    │                   │                      │                      │
    │                   │  confidence >= 0.7?  │                      │
    │                   │──── YES ────>        │                      │
    │  L1 result        │                      │                      │
    │<──────────────────│                      │                      │
    │                   │                      │                      │
    │                   │  confidence < 0.7    │                      │
    │                   │                      │                      │
    │                   │  create escalation   │                      │
    │                   │─────────────────────>│                      │
    │                   │                      │  ticket_id created   │
    │                   │<─────────────────────│                      │
    │                   │                      │                      │
    ╔═══════════════════╧══════════════════════╧══════════════════════╧═══════╗
    ║ ASYNC PATH (sync: false, default)                                      ║
    ╚═══════════════════╤══════════════════════╤══════════════════════╤═══════╝
    │                   │                      │                      │
    │  {status:         │                      │                      │
    │   "escalating",   │                      │                      │
    │   ticket_id,      │                      │                      │
    │   poll_url}       │                      │                      │
    │<──────────────────│                      │                      │
    │                   │                      │                      │
    │                   │                      │  spawn background L2 │
    │                   │                      │─────────────────────>│
    │                   │                      │                      │ call Sonnet
    │                   │                      │                      │──────>
    │                   │                      │                      │<─────
    │                   │                      │  L2 result           │
    │                   │                      │<─────────────────────│
    │                   │                      │                      │
    │                   │                      │  resolve escalation  │
    │                   │                      │  write notes file    │
    │                   │                      │  fire webhook (opt)  │
    │                   │                      │                      │
    │  GET /escalation/ │                      │                      │
    │  {ticket_id}      │                      │                      │
    │──────────────────────────────────────────>│                      │
    │  {status:         │                      │                      │
    │   "resolved",     │                      │                      │
    │   responses: [...]}                      │                      │
    │<─────────────────────────────────────────│                      │
    │                   │                      │                      │
    ╔═══════════════════╧══════════════════════╧══════════════════════╧═══════╗
    ║ SYNC PATH (sync: true)                                                 ║
    ╚═══════════════════╤══════════════════════╤══════════════════════╤═══════╝
    │                   │                      │                      │
    │                   │  call L2 directly    │                      │
    │                   │  (race: 8s timeout)  │                      │
    │                   │─────────────────────────────────────────────>│
    │                   │                      │                      │ call Sonnet
    │                   │                      │                      │──────>
    │                   │                      │                      │<─────
    │                   │<─────────────────────────────────────────────│
    │                   │                      │                      │
    │                   │  L2 responded in     │                      │
    │                   │  time?               │                      │
    │                   │                      │                      │
    │  L2 result        │  YES: return L2      │                      │
    │  {tier: "L2",     │                      │                      │
    │   escalated_from} │                      │                      │
    │<──────────────────│                      │                      │
    │                   │                      │                      │
    │  L1 result        │  NO (timeout):       │                      │
    │  {partial: true}  │  return L1 + partial │                      │
    │<──────────────────│                      │                      │
    │                   │                      │                      │
```

## Timeout Guarantees

| Tier | Budget | Used for |
|------|--------|----------|
| L1 (Haiku) | No limit | Initial response |
| L2 (Sonnet) | 10s | Background escalation |
| L3 (Opus) | 15s | Critical escalation |
| Sync caller wait | 8s | Maximum block time |

If a tier times out, the escalation manager returns the last-available tier's response with `{partial: true}`.

## State Lifecycle

```
pending ──── L2 responds ───> resolved
   │                              │
   │                              └── webhook fires (if configured)
   │
   └──── timeout (10s L2 / 15s L3) ───> timeout
                                            │
                                            └── best-available returned with partial flag
```

## Artifacts

Each escalation produces:
1. **Database row** in `escalation_state` table (ticket_id, tier_chain, status, responses, timestamps)
2. **Notes files** at `data/escalations/{ticket_id}-L1.md`, `{ticket_id}-L2.md` (reasoning trace)
3. **Log entries** in `ask_log` or `judge_log` with `escalated_from` and `escalation_reason` fields

## Trigger Conditions

| Endpoint | Condition | Escalation |
|----------|-----------|------------|
| `/ask` | `jsonMode: true` AND parsed confidence < 0.7 | L1 → L2 |
| `/judge` | confidence < 0.7 AND fallback not used | L1 → L2 |

L2 → L3 escalation is not currently auto-triggered (reserved for future `critical: true` gates).
