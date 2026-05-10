# Hook Architecture: Factory Floor Model

## Mental Model

**Opus = factory supervisor** — makes high-level decisions about what to build, how to approach problems, overall output quality. Doesn't worry about safety rails.

**Haiku = factory manager** — watches the levers and gears. Verifies that mechanical safety rules are followed. Doesn't make product decisions.

**JS gates = the levers and gears** — hard mechanical blocks. Regex pattern matching. Can't be reasoned with, can't be bypassed. `git reset --hard` → blocked, period.

```
User prompt
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│  UserPromptSubmit                                             │
│  Haiku L1 preprocessor reads prompt, writes l1-analysis.md   │
│  (intent parsing, shorthand expansion — ADVISORY ONLY)       │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
              Opus reads l1-analysis.md
              Opus decides what to do
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  PreToolUse (before each tool call)                           │
│                                                               │
│  Layer 1: JS gates (ENFORCEMENT)                              │
│    git-destructive-guard.js  — blocks force push, reset hard  │
│    archive-not-delete.js     — blocks rm, requires mv archive │
│    settings-watchdog-gate.js — blocks settings.json edits     │
│    secret-scan-gate.js       — blocks committing secrets      │
│    ... (mechanical pattern matching, no LLM)                  │
│                                                               │
│  Layer 2: Violation check (ENFORCEMENT via state file)        │
│    violation-gate.js         — reads violation-state.json     │
│    If Haiku flagged a violation last turn, BLOCK here with    │
│    instructions to read the analysis and correct course.      │
│    Clears the violation after Opus acknowledges it.           │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
              Tool executes (Bash, Edit, Write, etc.)
                       │
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  PostToolUse (after each tool call) — ASYNC, non-blocking     │
│                                                               │
│  Haiku spirit-check:                                          │
│    Reads what Opus just did (tool + input + output)           │
│    Evaluates against rule spirit (not just regex):            │
│      "Did this Bash command effectively delete files           │
│       without archiving, even though it wasn't literally rm?"  │
│      "Did this git operation lose uncommitted work?"           │
│      "Did this edit weaken a safety gate?"                     │
│                                                               │
│  If violation detected:                                       │
│    1. Writes violation-state.json:                             │
│       { rule, violation, severity, instructions }              │
│    2. Writes violation-analysis.md (detailed reasoning)        │
│    3. Next PreToolUse → violation-gate.js reads state,         │
│       BLOCKS Opus with "read violation-analysis.md"            │
│    4. Opus reads, corrects, violation cleared                  │
│                                                               │
│  If no violation: no state file, no block, zero overhead       │
└──────────────────────────────────────────────────────────────┘
```

## Why This Design

### Problem: Haiku can't make decisions for Opus

Haiku is fast and cheap but not smart enough to make nuanced judgment calls about what Opus should do. Previous attempts to have Haiku decide "should this session stop?" or "should this tool call proceed?" resulted in bad decisions — blocking valid work or allowing violations.

### Problem: Opus ignores advisory-only rules

If Haiku writes "don't force push" to l1-analysis.md and Opus doesn't read it (or reads it and disagrees), nothing stops the force push. Advisory rules have no teeth.

### Solution: Separation of concerns

| Layer | Who | Role | Enforcement |
|-------|-----|------|-------------|
| JS gates | Nobody (regex) | Mechanical blocks | Hard — blocks tool call |
| Haiku PostToolUse | Haiku | Spirit verification | Soft → Hard (writes state file → next PreToolUse blocks) |
| l1-analysis.md | Haiku | Intent parsing | Advisory only |
| Opus | Opus | All decisions | Self-directed |

**JS gates stay for mechanical enforcement.** `git reset --hard` is always wrong in this workflow. No LLM judgment needed. These gates are 0-latency regex checks that can't be bypassed.

**Haiku audits the spirit, not the letter.** After Opus acts, Haiku checks: "Did that `mv` command effectively delete files by moving them to /dev/null?" or "Did that edit gut a safety gate by adding `return null` at the top?" These are things regex can't catch but Haiku can.

**The state file is the enforcement bridge.** Haiku can't block tool calls directly (it's async, PostToolUse). But it can write to `violation-state.json`, which the synchronous `violation-gate.js` reads on the next PreToolUse. This turns Haiku's async finding into a hard block.

## Rule Categories

### Category 1: Mechanical enforcement (JS gates, keep as-is)

These rules are pattern-matchable with regex. No LLM needed. Keep them as JS PreToolUse gates.

| Gate | What it blocks |
|------|---------------|
| `git-destructive-guard.js` | `git reset --hard`, `git checkout .`, `git clean -f` |
| `archive-not-delete.js` | `rm`, `rmdir` (requires `mv archive/`) |
| `settings-watchdog-gate.js` | Any write to `~/.claude/settings.json` |
| `secret-scan-gate.js` | Committing `.env`, credentials, tokens |
| `force-push-gate.js` | `git push --force` to main/master |

### Category 2: Spirit verification (Haiku PostToolUse)

These rules check intent and context. Regex can't catch them. Haiku evaluates after the fact.

| Rule | What Haiku checks |
|------|------------------|
| Archive spirit | Did Opus effectively delete files via rename to temp/nonexistent paths? |
| Gate weakening | Did an edit add `return null` or remove block logic from a gate? |
| Destructive git spirit | Did a sequence of commands achieve the same result as `reset --hard`? |
| Settings bypass | Did Opus modify settings.json indirectly (via python, node, etc.)? |
| Scope creep | Did Opus make changes outside the requested scope? |

### Category 3: Advisory (l1-analysis.md, no enforcement)

These are context/intent hints for Opus. No enforcement mechanism needed.

- Prompt shorthand expansion
- Project context reminders
- Style preferences
- Suggested approaches

## State File Format

`~/.claude/hooks/violation-state.json`:

```json
{
  "violation": true,
  "timestamp": "2026-05-10T17:00:00Z",
  "rule": "archive-not-delete-spirit",
  "severity": "high",
  "tool_name": "Bash",
  "tool_input": "mv important-data.db /dev/null",
  "violation_description": "File moved to /dev/null — effectively deleted, not archived",
  "instructions": "Read ~/.claude/hooks/violation-analysis.md for details. Restore the file and move it to archive/ instead.",
  "acknowledged": false
}
```

When `violation-gate.js` (PreToolUse) reads this file and `acknowledged` is false:
1. Block the current tool call
2. Return `reason` with instructions to read violation-analysis.md
3. Set `acknowledged: true` (Opus has been told)
4. Next tool call proceeds (Opus should now correct the issue)

## Files

| File | Purpose |
|------|---------|
| `~/.claude/hooks/run-modules/PostToolUse/spirit-check.js` | Haiku PostToolUse auditor — evaluates rule spirit |
| `~/.claude/hooks/run-modules/PreToolUse/violation-gate.js` | Reads violation-state.json, blocks if unacknowledged violation |
| `~/.claude/hooks/violation-state.json` | State file for PostToolUse → PreToolUse communication |
| `~/.claude/hooks/violation-analysis.md` | Haiku's detailed reasoning about the violation |
| `~/.claude/proxy/spirit-rules.yaml` | YAML rules for Haiku spirit checks |
| `docs/hook-architecture.md` | This file |

## Adding New Rules

### To add a mechanical enforcement rule (regex):
1. Create `~/.claude/hooks/run-modules/PreToolUse/my-rule.js`
2. Pattern: `if (regex.test(cmd)) return { decision: "block", reason: "..." }`
3. No Haiku, no state file, no latency

### To add a spirit verification rule (Haiku):
1. Add to `~/.claude/proxy/spirit-rules.yaml`:
   ```yaml
   - name: my-spirit-rule
     check: "Did the tool call do X even though it wasn't literally Y?"
     severity: high
     tools: [Bash, Edit]
   ```
2. Haiku evaluates it automatically on matching tool calls
3. Violations → state file → next PreToolUse blocks

### To add an advisory rule:
1. Add to `~/.claude/proxy/userprompt-haiku-rules.yaml`
2. Haiku writes it to l1-analysis.md
3. Opus may or may not follow it — that's fine for advisory rules
