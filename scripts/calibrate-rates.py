#!/usr/bin/env python3
"""
Rate Calibration Script — finds optimal per-token rates that minimize
error between the tracker's cost estimates and the RDsec portal's actual bills.

Usage:
  python3 scripts/calibrate-rates.py
  python3 scripts/calibrate-rates.py --portal scripts/portal-data.json --db ~/.token-proxy/usage.db
  python3 scripts/calibrate-rates.py --start 2026-05-16 --end 2026-05-18  # post-enforcement only

Tests two hypotheses:
  H1: RDsec charges separate rates for input/output/cache_read/cache_write (4 unknowns)
  H2: RDsec charges flat input rate + output rate (2 unknowns, all input tokens same price)

Outputs optimal rates, fit quality, and recommended config.yaml values.
"""

import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import lsq_linear, least_squares

SCRIPT_DIR = Path(__file__).parent
PROJECT_DIR = SCRIPT_DIR.parent
DEFAULT_PORTAL = SCRIPT_DIR / "portal-data.json"
DEFAULT_DB = Path.home() / ".token-proxy" / "usage.db"


def load_portal(path):
    with open(path) as f:
        return json.load(f)


def load_tracker_daily(db_path, start=None, end=None):
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    where = "WHERE upstream = 'rdsec'"
    if start:
        where += f" AND date(timestamp) >= '{start}'"
    if end:
        where += f" AND date(timestamp) <= '{end}'"

    rows = conn.execute(f"""
        SELECT
            date(timestamp) as day,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cache_read_tokens) as cache_read_tokens,
            SUM(cache_write_tokens) as cache_write_tokens,
            SUM(CASE WHEN cache_estimated = 1 THEN cache_read_tokens ELSE 0 END) as estimated_cache_read,
            SUM(CASE WHEN cache_estimated = 1 THEN cache_write_tokens ELSE 0 END) as estimated_cache_write,
            COUNT(*) as calls,
            SUM(CASE WHEN cache_estimated = 1 THEN 1 ELSE 0 END) as estimated_calls,
            SUM(estimated_cost_usd) as tracker_cost
        FROM usage_log
        {where}
        GROUP BY day
        ORDER BY day
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def match_days(portal, tracker):
    tracker_by_day = {r["day"]: r for r in tracker}
    matched = []
    for p in portal:
        t = tracker_by_day.get(p["date"])
        if t and t["calls"] > 0:
            matched.append({"portal": p, "tracker": t})
    return matched


def build_matrix_h1(matched):
    """H1: 4 separate rates [input, output, cache_read, cache_write]"""
    n = len(matched)
    A = np.zeros((n, 4))
    y = np.zeros(n)
    weights = np.ones(n)

    for i, m in enumerate(matched):
        t = m["tracker"]
        A[i, 0] = t["input_tokens"] / 1e6
        A[i, 1] = t["output_tokens"] / 1e6
        A[i, 2] = t["cache_read_tokens"] / 1e6
        A[i, 3] = t["cache_write_tokens"] / 1e6
        y[i] = m["portal"]["cost"]

        est_ratio = t["estimated_calls"] / max(t["calls"], 1)
        weights[i] = 1.0 - 0.5 * est_ratio

    return A, y, weights


def build_matrix_h2(matched):
    """H2: 2 rates [flat_input, output] — all input tokens charged same"""
    n = len(matched)
    A = np.zeros((n, 2))
    y = np.zeros(n)
    weights = np.ones(n)

    for i, m in enumerate(matched):
        t = m["tracker"]
        total_input = t["input_tokens"] + t["cache_read_tokens"] + t["cache_write_tokens"]
        A[i, 0] = total_input / 1e6
        A[i, 1] = t["output_tokens"] / 1e6
        y[i] = m["portal"]["cost"]

        est_ratio = t["estimated_calls"] / max(t["calls"], 1)
        weights[i] = 1.0 - 0.5 * est_ratio

    return A, y, weights


def solve_h1(A, y, weights):
    """Constrained least squares: rates >= 0"""
    W = np.diag(np.sqrt(weights))
    Aw = W @ A
    yw = W @ y

    result = lsq_linear(
        Aw, yw,
        bounds=(
            [0, 0, 0, 0],
            [50, 150, 10, 50]
        )
    )
    rates = result.x
    residuals = A @ rates - y
    ss_res = np.sum((residuals * weights) ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2 * weights)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0

    return {
        "rates": {"input": rates[0], "output": rates[1], "cache_read": rates[2], "cache_write": rates[3]},
        "residuals": residuals,
        "r2": r2,
        "rmse": np.sqrt(np.mean(residuals**2)),
        "n_params": 4,
    }


def solve_h2(A, y, weights):
    """Constrained least squares: flat input + output rates >= 0"""
    W = np.diag(np.sqrt(weights))
    Aw = W @ A
    yw = W @ y

    result = lsq_linear(
        Aw, yw,
        bounds=(
            [0, 0],
            [50, 150]
        )
    )
    rates = result.x
    residuals = A @ rates - y
    ss_res = np.sum((residuals * weights) ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2 * weights)
    r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0

    return {
        "rates": {"flat_input": rates[0], "output": rates[1]},
        "residuals": residuals,
        "r2": r2,
        "rmse": np.sqrt(np.mean(residuals**2)),
        "n_params": 2,
    }


def aic(n, k, ss_res):
    if n <= 0 or ss_res <= 0:
        return float("inf")
    return n * np.log(ss_res / n) + 2 * k


def print_results(matched, h1, h2):
    print("=" * 70)
    print("  RATE CALIBRATION RESULTS")
    print("=" * 70)
    print()

    print("H1: Separate rates (input / output / cache_read / cache_write)")
    print(f"  input:       ${h1['rates']['input']:.4f}/M")
    print(f"  output:      ${h1['rates']['output']:.4f}/M")
    print(f"  cache_read:  ${h1['rates']['cache_read']:.4f}/M")
    print(f"  cache_write: ${h1['rates']['cache_write']:.4f}/M")
    print(f"  R²: {h1['r2']:.4f}  RMSE: ${h1['rmse']:.2f}")
    print()

    print("H2: Flat input rate (all input tokens same price)")
    print(f"  flat_input:  ${h2['rates']['flat_input']:.4f}/M")
    print(f"  output:      ${h2['rates']['output']:.4f}/M")
    print(f"  R²: {h2['r2']:.4f}  RMSE: ${h2['rmse']:.2f}")
    print()

    n = len(matched)
    ss1 = np.sum(h1["residuals"]**2)
    ss2 = np.sum(h2["residuals"]**2)
    aic1 = aic(n, h1["n_params"], ss1)
    aic2 = aic(n, h2["n_params"], ss2)

    print(f"Model comparison (lower AIC = better fit for complexity):")
    print(f"  H1 (4 params): AIC = {aic1:.2f}")
    print(f"  H2 (2 params): AIC = {aic2:.2f}")
    winner = "H1 (separate rates)" if aic1 < aic2 else "H2 (flat input)"
    print(f"  Winner: {winner}")
    print()

    print("-" * 70)
    print("Per-day fit:")
    print(f"  {'Date':<12} {'Portal':>10} {'H1 pred':>10} {'H1 err':>10} {'H2 pred':>10} {'H2 err':>10}")
    for i, m in enumerate(matched):
        p_cost = m["portal"]["cost"]
        h1_pred = p_cost + h1["residuals"][i]
        h2_pred = p_cost + h2["residuals"][i]
        print(f"  {m['portal']['date']:<12} ${p_cost:>8.2f} ${h1_pred:>8.2f} {h1['residuals'][i]:>+9.2f} ${h2_pred:>8.2f} {h2['residuals'][i]:>+9.2f}")
    print()

    print("-" * 70)
    print("RECOMMENDED config.yaml (using winning model):")
    print()
    if aic1 < aic2:
        r = h1["rates"]
        print("upstream_pricing:")
        print("  rdsec:")
        print(f"    claude-opus-4-6:   {{ input: {r['input']:.2f}, output: {r['output']:.2f}, cache_read: {r['cache_read']:.4f}, cache_write: {r['cache_write']:.2f} }}")
        print(f"    claude-sonnet-4-6: {{ input: {r['input']*0.2:.2f}, output: {r['output']*0.2:.2f}, cache_read: {r['cache_read']*0.2:.4f}, cache_write: {r['cache_write']*0.2:.2f} }}")
    else:
        r = h2["rates"]
        print("upstream_pricing:")
        print("  rdsec:")
        print(f"    claude-opus-4-6:   {{ input: {r['flat_input']:.4f}, output: {r['output']:.2f}, cache_read: {r['flat_input']:.4f}, cache_write: {r['flat_input']:.4f} }}")
        print(f"    # Note: RDsec uses flat input rate — cache_read = cache_write = input rate")
    print()


def main():
    parser = argparse.ArgumentParser(description="Calibrate RDsec per-token rates from portal billing data")
    parser.add_argument("--portal", default=str(DEFAULT_PORTAL), help="Path to portal-data.json")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to usage.db")
    parser.add_argument("--start", help="Start date (YYYY-MM-DD), default: use all available")
    parser.add_argument("--end", help="End date (YYYY-MM-DD)")
    args = parser.parse_args()

    if not os.path.exists(args.portal):
        print(f"Error: portal data not found at {args.portal}", file=sys.stderr)
        sys.exit(1)
    if not os.path.exists(args.db):
        print(f"Error: database not found at {args.db}", file=sys.stderr)
        sys.exit(1)

    portal = load_portal(args.portal)
    tracker = load_tracker_daily(args.db, args.start, args.end)

    if args.start:
        portal = [p for p in portal if p["date"] >= args.start]
    if args.end:
        portal = [p for p in portal if p["date"] <= args.end]

    matched = match_days(portal, tracker)

    if len(matched) < 2:
        print(f"Error: need at least 2 matched days, got {len(matched)}", file=sys.stderr)
        print(f"  Portal days: {[p['date'] for p in portal]}", file=sys.stderr)
        print(f"  Tracker days: {[t['day'] for t in tracker]}", file=sys.stderr)
        sys.exit(1)

    print(f"Matched {len(matched)} days between portal and tracker")
    print(f"Date range: {matched[0]['portal']['date']} → {matched[-1]['portal']['date']}")
    print()

    A1, y1, w1 = build_matrix_h1(matched)
    A2, y2, w2 = build_matrix_h2(matched)

    h1 = solve_h1(A1, y1, w1)
    h2 = solve_h2(A2, y2, w2)

    print_results(matched, h1, h2)


if __name__ == "__main__":
    main()
