# Rate Calibration — RDsec Pricing Model

## Summary

RDsec charges a **flat per-input-token rate** regardless of cache status, plus a per-output-token rate. They do NOT differentiate between cached and fresh input tokens.

| Token Type | RDsec Rate (Opus) | Anthropic Direct Rate |
|------------|-------------------|-----------------------|
| All input (incl. cache) | $0.52/M | $15.00/M (fresh), $1.50/M (cache_read), $18.75/M (cache_write) |
| Output | $54.26/M | $75.00/M |

## How This Was Determined

### 1. Live Portal Data (2026-05-19)

Used Blueprint MCP to open `portal.rdsec.trendmicro.com/chatbot/aiendpoint` and extract the "Token Usage and Cost" table — 28 days of billing data with columns: Date, Traces, Input Tokens, Output Tokens, Total Tokens, Cost.

### 2. Hypothesis Testing with scipy

Tested two pricing models using `scipy.optimize.lsq_linear` (constrained least-squares, rates bounded >= 0):

**H1: Separate rates** (4 variables — input, output, cache_read, cache_write)
- Used our tracker's per-call token breakdown as predictors
- Result: R² = 0.77, RMSE = $73.91 — poor fit, rates hit bounds

**H2: Flat input rate** (2 variables — one rate for all input tokens, one for output)
- Used portal's own "Input Tokens" and "Output Tokens" as predictors
- Result: **R² = 0.9993**, RMSE = negligible — near-perfect fit
- Solved rates: flat_input = $0.5199/M, output = $54.26/M

### 3. Model Selection

AIC comparison favors H2 (simpler model, better fit). The portal's "Input Tokens" column includes all prompt tokens (fresh + cache_read + cache_write) at a single rate.

### 4. Validation (May 15-18 portal data)

```
Date       Portal    Predicted   Error
May 15     $221.64   $221.61     -$0.03 (0.0%)
May 16     $126.82   $127.43     +$0.61 (0.5%)
May 17     $41.51    $38.03      -$3.48 (8.4%)
May 18     $33.59    $35.32      +$1.73 (5.2%)
```

## Implementation

### pricing.js

Added `flat_input` field detection. When a rate entry has `flat_input` instead of separate `input`/`cache_read`/`cache_write`, the cost formula becomes:

```
cost = (input_tokens + cache_read_tokens + cache_write_tokens) / 1M * flat_input
     + output_tokens / 1M * output
```

### config.yaml

```yaml
upstream_pricing:
  rdsec:
    claude-opus-4-6: { flat_input: 0.52, output: 54.26 }
```

### Scaling for non-Opus models

Sonnet and Haiku rates are scaled proportionally (Opus is the anchor):
- Sonnet: flat_input = $0.10/M, output = $10.85/M (~5x cheaper)
- Haiku: flat_input = $0.02/M, output = $2.17/M (~25x cheaper)

These are estimates — only Opus has enough data volume for confident calibration.

## Running the Calibration

```bash
# Full calibration (all matched days)
python3 scripts/calibrate-rates.py

# Specific date range
python3 scripts/calibrate-rates.py --start 2026-05-15 --end 2026-05-18

# After updating rates, recalculate historical costs
node scripts/recalc-costs.js --execute

# Verify against portal
node scripts/cost-audit.js --date 2026-05-17 --reconcile 41.51
```

## Portal Data Source

Portal billing data stored in `scripts/portal-data.json`. To refresh:
1. Open RDsec portal via Blueprint MCP
2. Extract the "Daily Cost Details" table
3. Update `portal-data.json` with new entries

## Known Limitations

1. **Portal = all account users** — The portal total includes all team members using the AI Endpoint, not just this user. Tracker only captures calls through our local proxy.
2. **Cache estimation heuristic** — On days with many cache-estimated calls, tracker may slightly overestimate (the heuristic assumes 200K context per subsequent call).
3. **Sonnet/Haiku rates are estimates** — Derived by scaling Opus rates, not independently calibrated (insufficient data volume for those models).
