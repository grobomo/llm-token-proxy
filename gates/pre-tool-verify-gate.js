#!/usr/bin/env node
"use strict";
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ PRE-TOOL VERIFY GATE — Check preconditions before tool execution        │
// │                                                                         │
// │ On PreToolUse: Haiku evaluates whether the tool call makes assumptions  │
// │ that should be verified first (e.g., checking if SSH keys exist before  │
// │ assuming they don't, checking if CLI tools are authed before asking).   │
// │ Never blocks — injects verification suggestions as additionalContext.   │
// │                                                                         │
// │ Install: symlink or copy into ~/.claude/hooks/run-modules/PreToolUse/   │
// │ Requires: haiku-client.js in ~/.claude/hooks/                           │
// └─────────────────────────────────────────────────────────────────────────┘

var fs = require("fs");
var path = require("path");

var HOME = process.env.HOME || "/home/ubu";
var haiku = require(path.join(HOME, ".claude", "hooks", "haiku-client"));

var RULES_PATH = process.env.VERIFY_RULES_PATH || path.join(HOME, ".claude", "proxy", "verify-rules.yaml");
var ANALYSIS_PATH = path.join(HOME, ".claude", "hooks", "pre-tool-verify.md");
var DECISION_LOG = path.join(HOME, ".claude", "hooks", "verify-decisions.jsonl");
var LOG_PATH = path.join(HOME, ".claude", "hooks", "hook-log.jsonl");

// Only audit certain tools that commonly involve assumptions
var VERIFY_TOOLS = ["Bash", "AskUserQuestion"];
// Rate limit: max 1 verification per 30s to avoid hammering Haiku
var _lastCallMs = 0;
var RATE_LIMIT_MS = 30000;

function log(entry) {
  entry.ts = new Date().toISOString();
  entry.module = "pre-tool-verify-gate";
  entry.event = "PreToolUse";
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8"); } catch (e) {}
}

function logDecision(entry) {
  entry.ts = new Date().toISOString();
  try { fs.appendFileSync(DECISION_LOG, JSON.stringify(entry) + "\n", "utf-8"); } catch (e) {}
}

module.exports = function(input) {
  if (!input) return null;

  var toolName = input.tool_name || input.toolName || "";
  if (VERIFY_TOOLS.indexOf(toolName) === -1) return null;

  // Rate limit
  var now = Date.now();
  if (now - _lastCallMs < RATE_LIMIT_MS) return null;

  var toolInput = input.tool_input || input.input || {};
  var inputStr = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput);

  // For AskUserQuestion: check if the question could be answered by checking the system first
  // For Bash: check if the command assumes something that should be verified
  var isAskingUser = toolName === "AskUserQuestion";
  var isBash = toolName === "Bash";

  // Quick heuristic: skip simple commands that don't involve assumptions
  if (isBash) {
    var cmd = toolInput.command || inputStr;
    // Skip simple reads, greps, status checks — these ARE verification
    if (/^(ls|cat|grep|find|git status|git log|head|tail|wc|which|echo|pwd)/.test(cmd.trim())) return null;
  }

  // Read rules (optional)
  var rules = "";
  try { rules = fs.readFileSync(RULES_PATH, "utf-8"); } catch (e) {}

  var prompt;
  if (isAskingUser) {
    prompt = [
      "You are the Verify Gate. Before the assistant asks the user a question,",
      "check if the question could be answered by first checking the system.",
      "",
      rules ? "RULES:\n" + rules + "\n" : "",
      "QUESTION BEING ASKED TO USER:",
      inputStr.slice(0, 1000),
      "",
      "Could the assistant answer this themselves by running a command first?",
      "Examples: checking if a tool is installed, checking if keys exist, checking",
      "if a service is configured, checking if a file exists.",
      "",
      "Respond with JSON:",
      '{"should_verify": true|false, "verification": "command or check to run first, or null", "reason": "why"}',
    ].join("\n");
  } else {
    prompt = [
      "You are the Verify Gate. Before a tool executes, check if it makes",
      "assumptions that should be verified first.",
      "",
      rules ? "RULES:\n" + rules + "\n" : "",
      "TOOL: " + toolName,
      "INPUT: " + inputStr.slice(0, 1000),
      "",
      "Does this tool call assume something exists or is configured without",
      "checking first? Examples: assuming a key doesn't exist without looking,",
      "assuming a service isn't running without checking, assuming no access.",
      "",
      "Respond with JSON:",
      '{"should_verify": true|false, "verification": "what to check first, or null", "reason": "why"}',
    ].join("\n");
  }

  _lastCallMs = now;

  var result = haiku.call({
    prompt: prompt,
    caller: "pre-tool-verify-gate",
    jsonMode: true,
    maxTokens: 200,
    timeoutMs: 5000
  });

  if (!result.ok) {
    log({ result: "haiku_fail", tool: toolName, error: result.error, ms: result.ms });
    return null;
  }

  var parsed = result.parsed;
  var shouldVerify = parsed.should_verify === true;
  var verification = parsed.verification || null;
  var reason = parsed.reason || "";

  logDecision({
    tool: toolName,
    should_verify: shouldVerify,
    verification: verification,
    reason: reason,
    input_preview: inputStr.slice(0, 200),
    ms: result.ms
  });

  // Write analysis
  var analysis = [
    "# Pre-Tool Verification",
    "**Timestamp:** " + new Date().toISOString(),
    "**Tool:** " + toolName,
    "**Should verify:** " + (shouldVerify ? "YES" : "NO"),
    shouldVerify ? "**Verification:** " + verification : "",
    "**Reason:** " + reason,
    "**Latency:** " + result.ms + "ms"
  ].filter(Boolean).join("\n");

  try { fs.writeFileSync(ANALYSIS_PATH, analysis, "utf-8"); } catch (e) {}

  log({
    result: shouldVerify ? "suggest_verify" : "pass",
    tool: toolName,
    verification: verification,
    reason: reason,
    ms: result.ms
  });

  // Never block — just suggest. Return null always.
  // The suggestion shows up in the analysis file for observability.
  // Future: could inject as additionalContext if hook system supports it.
  return null;
};
