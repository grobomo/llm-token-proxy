# Haiku Gates

Reusable Claude Code hook gates. Each gate calls Haiku (via the local proxy at :4100) to make decisions, writes its reasoning to a file, and logs everything.

## Install

```bash
git clone https://github.com/grobomo/llm-token-proxy
cd llm-token-proxy/gates
./install.sh all        # or: ./install.sh stop | ./install.sh post-tool-use
```

## Gates

| Gate | Event | Mode | Writes to |
|------|-------|------|-----------|
| `stop-analysis-gate.js` | Stop | blocking (continue/stop) | `~/.claude/hooks/stop-analysis.md` |
| `post-tool-use-gate.js` | PostToolUse | observe-only (never blocks) | `~/.claude/hooks/post-tool-analysis.md` |
| `pre-tool-verify-gate.js` | PreToolUse | observe-only (never blocks) | `~/.claude/hooks/pre-tool-verify.md` |

## How they work

All gates follow the same pattern:

1. **Read rules** — from a YAML file in `~/.claude/proxy/`
2. **Gather context** — session transcript, tool input/output, etc.
3. **Call Haiku** — via `haiku-client.js` → proxy at `:4100/v1/chat/completions`
4. **Parse JSON response** — structured decision with confidence + reasoning
5. **Write analysis** — markdown file (latest decision, human-readable)
6. **Log decision** — append to JSONL (full history, machine-readable)
7. **Return verdict** — block/pass depending on gate type

## Logs

| File | Contents |
|------|----------|
| `~/.claude/hooks/hook-log.jsonl` | All hook events (shared across gates) |
| `~/.claude/hooks/tool-audit-decisions.jsonl` | PostToolUse decisions (effective/redundant/failed) |
| `~/.claude/hooks/verify-decisions.jsonl` | PreToolUse verification suggestions |
| `~/.claude/hooks/stop-analysis.md` | Last stop gate reasoning |
| `~/.claude/hooks/post-tool-analysis.md` | Last tool audit reasoning |
| `~/.claude/hooks/pre-tool-verify.md` | Last verification suggestion |

## Config

| Env var | Default | Purpose |
|---------|---------|---------|
| `STOP_RULES_PATH` | `~/.claude/proxy/stop-haiku-rules.yaml` | Stop gate rules |
| `TOOL_AUDIT_RULES_PATH` | `~/.claude/proxy/tool-audit-rules.yaml` | Tool audit rules |
| `TOOL_AUDIT_SAMPLE_RATE` | `0.3` | Fraction of tool calls to deep-audit (0.0-1.0) |
| `VERIFY_RULES_PATH` | `~/.claude/proxy/verify-rules.yaml` | Pre-verify gate rules |
| `LLM_PROXY_AUTH` | from `~/.claude/settings.json` | API key for proxy auth |

## Adding a new gate

Copy any existing gate file as a template. The structure is identical:
- Change the `RULES_PATH`, `ANALYSIS_PATH`, `DECISION_LOG` paths
- Change the Haiku prompt to match your event's context
- Change `module.exports` return: `null` = pass, `{decision:"block", reason:"..."}` = block

## Dependencies

- Node.js >= 18
- LLM Token Proxy running at `:4100` (this repo)
- `curl` (used by haiku-client.js for sync calls)
