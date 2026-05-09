#!/usr/bin/env node
"use strict";
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ POST TOOL USE GATE — Haiku audits tool effectiveness after each call    │
// │                                                                         │
// │ On every PostToolUse event: calls Haiku to classify whether the tool    │
// │ was used effectively or if process improvements should be made.         │
// │ Writes reasoning to post-tool-analysis.md, logs to decision log.       │
// │ Never blocks — audit/observe only.                                      │
// │                                                                         │
// │ Install: symlink or copy into ~/.claude/hooks/run-modules/PostToolUse/  │
// │ Requires: haiku-client.js in same directory (or parent hooks dir)       │
// │ Config:  TOOL_AUDIT_RULES_PATH env or uses built-in rules              │
// └─────────────────────────────────────────────────────────────────────────┘

var fs = require("fs");
var path = require("path");

var HOME = process.env.HOME || "/home/ubu";
var haiku = require(path.join(HOME, ".claude", "hooks", "haiku-client"));
var RULES_PATH = process.env.TOOL_AUDIT_RULES_PATH || path.join(HOME, ".claude", "proxy", "tool-audit-rules.yaml");
var ANALYSIS_PATH = path.join(HOME, ".claude", "hooks", "post-tool-analysis.md");
var DECISION_LOG = path.join(HOME, ".claude", "hooks", "tool-audit-decisions.jsonl");
var LOG_PATH = path.join(HOME, ".claude", "hooks", "hook-log.jsonl");

// Rate limit: don't call Haiku on every single tool use — sample or batch
var SAMPLE_RATE = parseFloat(process.env.TOOL_AUDIT_SAMPLE_RATE || "0.3"); // 30% by default
var ALWAYS_AUDIT_TOOLS = ["Bash", "Write", "Edit"]; // always audit these

function log(entry) {
  entry.ts = new Date().toISOString();
  entry.module = "post-tool-use-gate";
  entry.event = "PostToolUse";
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8"); } catch (e) {}
}

function logDecision(entry) {
  entry.ts = new Date().toISOString();
  try { fs.appendFileSync(DECISION_LOG, JSON.stringify(entry) + "\n", "utf-8"); } catch (e) {}
}

function getSessionId() {
  return (process.env.CLAUDE_SESSION_ID || "unknown").slice(0, 8);
}

function shouldAudit(toolName) {
  if (ALWAYS_AUDIT_TOOLS.indexOf(toolName) !== -1) return true;
  return Math.random() < SAMPLE_RATE;
}

module.exports = function(input) {
  if (!input) return null;

  var toolName = input.tool_name || input.toolName || "unknown";
  var toolInput = input.tool_input || input.input || "";
  var toolOutput = input.tool_output || input.output || "";

  // Always log the raw tool use (lightweight, no Haiku call)
  logDecision({
    type: "tool_use",
    tool: toolName,
    input_preview: (typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput)).slice(0, 200),
    output_preview: (typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput)).slice(0, 200),
    audited: false
  });

  // Decide whether to deep-audit this call
  if (!shouldAudit(toolName)) return null;

  // Read rules (optional — works without them)
  var rules = "";
  try { rules = fs.readFileSync(RULES_PATH, "utf-8"); } catch (e) {}

  var inputStr = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput);
  var outputStr = typeof toolOutput === "string" ? toolOutput : JSON.stringify(toolOutput);

  var prompt = [
    "You are the Tool Audit Gate. After each tool use by the main assistant (Opus),",
    "you classify whether it was effective and suggest process improvements.",
    "",
    rules ? "AUDIT RULES:\n" + rules + "\n" : "",
    "TOOL CALL:",
    "  Tool: " + toolName,
    "  Input: " + inputStr.slice(0, 800),
    "  Output (truncated): " + outputStr.slice(0, 800),
    "",
    "Classify this tool use. Respond with JSON:",
    '{',
    '  "effective": true|false,',
    '  "category": "productive"|"redundant"|"failed"|"suboptimal"|"excellent",',
    '  "reason": "one sentence",',
    '  "improvement": "suggestion or null if no improvement needed",',
    '  "pattern": "name this pattern if recurring (e.g. read-before-edit, grep-for-symbol) or null"',
    '}'
  ].join("\n");

  var result = haiku.call({
    prompt: prompt,
    caller: "post-tool-use-gate",
    jsonMode: true,
    maxTokens: 300,
    timeoutMs: 6000
  });

  var sessionId = getSessionId();

  if (!result.ok) {
    log({ result: "haiku_fail", tool: toolName, error: result.error, ms: result.ms });
    logDecision({
      type: "audit_fail",
      tool: toolName,
      session: sessionId,
      error: result.error,
      ms: result.ms,
      audited: true
    });
    return null; // never block
  }

  var parsed = result.parsed;
  var effective = parsed.effective !== false;
  var category = parsed.category || "productive";
  var reason = parsed.reason || "";
  var improvement = parsed.improvement || null;
  var pattern = parsed.pattern || null;

  // Log the audit decision
  logDecision({
    type: "audit",
    tool: toolName,
    session: sessionId,
    effective: effective,
    category: category,
    reason: reason,
    improvement: improvement,
    pattern: pattern,
    ms: result.ms,
    audited: true
  });

  // Write analysis file (overwrites each time — latest audit visible)
  var analysis = [
    "# Post-Tool-Use Analysis",
    "**Session:** " + sessionId,
    "**Timestamp:** " + new Date().toISOString(),
    "**Tool:** " + toolName,
    "",
    "**Effective:** " + (effective ? "YES" : "NO"),
    "**Category:** " + category,
    "**Reason:** " + reason,
    improvement ? "**Improvement:** " + improvement : "",
    pattern ? "**Pattern:** " + pattern : "",
    "**Latency:** " + result.ms + "ms",
    "",
    "## Tool Input (truncated)",
    "```",
    inputStr.slice(0, 500),
    "```",
    "",
    "## Tool Output (truncated)",
    "```",
    outputStr.slice(0, 500),
    "```"
  ].filter(Boolean).join("\n");

  try { fs.writeFileSync(ANALYSIS_PATH, analysis, "utf-8"); } catch (e) {}

  log({
    result: category,
    tool: toolName,
    effective: effective,
    improvement: improvement,
    pattern: pattern,
    ms: result.ms
  });

  // Never block — this is observe-only
  return null;
};
