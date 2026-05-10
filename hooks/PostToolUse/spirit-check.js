#!/usr/bin/env node
"use strict";
// WORKFLOW: wsl
// TOOLS: Bash, Edit, Write
// WHY: JS gates catch literal violations (rm -rf, git reset --hard) but miss
// creative workarounds (mv to /dev/null, echo '' > file, python overwrite).
// Haiku audits the SPIRIT of enforcement rules after each tool call.
// On violation: writes violation-state.json → next PreToolUse blocks Opus.
//
// Architecture: docs/hook-architecture.md — "Factory Floor Model"
//   Haiku = factory manager (watches levers and gears)
//   Opus  = factory supervisor (makes product decisions)
//   JS gates = levers and gears (mechanical enforcement)

var fs = require("fs");
var path = require("path");

var HOME = process.env.HOME || "/home/ubu";
var haiku = require(path.join(HOME, ".claude", "hooks", "haiku-client"));

var RULES_PATH = process.env.SPIRIT_RULES_PATH || path.join(HOME, ".claude", "proxy", "spirit-rules.yaml");
var STATE_PATH = path.join(HOME, ".claude", "hooks", "violation-state.json");
var ANALYSIS_PATH = path.join(HOME, ".claude", "hooks", "violation-analysis.md");
var LOG_PATH = path.join(HOME, ".claude", "hooks", "hook-log.jsonl");

function log(entry) {
  entry.ts = new Date().toISOString();
  entry.module = "spirit-check";
  entry.event = "PostToolUse";
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8"); } catch (e) {}
}

function loadRules() {
  try {
    var content = fs.readFileSync(RULES_PATH, "utf-8");
    var rules = [];
    var current = null;
    var lines = content.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^- name:/.test(line)) {
        if (current) rules.push(current);
        current = { name: line.replace(/^- name:\s*/, "").trim() };
      } else if (current) {
        var m;
        if ((m = line.match(/^\s+check:\s*>?\s*(.*)/))) {
          current.check = (current.check || "") + m[1];
        } else if ((m = line.match(/^\s+severity:\s*(.*)/))) {
          current.severity = m[1].trim();
        } else if ((m = line.match(/^\s+tools:\s*\[(.*)\]/))) {
          current.tools = m[1].split(",").map(function(t) { return t.trim(); });
        } else if (/^\s+/.test(line) && current.check !== undefined && !/^\s+(severity|tools|gate|name):/.test(line)) {
          current.check = (current.check || "") + " " + line.trim();
        }
      }
    }
    if (current) rules.push(current);
    return rules;
  } catch (e) {
    log({ result: "no_rules", error: e.message });
    return [];
  }
}

module.exports = function(input) {
  if (!input) return null;

  var toolName = input.tool_name || "unknown";
  var toolInput = input.tool_input || {};
  var toolOutput = (input.tool_output || "").toString().slice(0, 1000);

  var rules = loadRules();
  if (rules.length === 0) return null;

  var applicable = rules.filter(function(r) {
    if (!r.tools || r.tools.length === 0) return true;
    return r.tools.indexOf(toolName) !== -1;
  });
  if (applicable.length === 0) return null;

  var cmd = toolInput.command || toolInput.file_path || "";
  if (typeof toolInput === "object") {
    try { cmd = JSON.stringify(toolInput).slice(0, 500); } catch (e) {}
  }

  var checksText = applicable.map(function(r, i) {
    return (i + 1) + ". [" + r.name + "] " + r.check;
  }).join("\n");

  var prompt = [
    "You are a post-action auditor. A tool call just completed. Check if it violated any rules.",
    "",
    "TOOL: " + toolName,
    "INPUT: " + cmd.slice(0, 500),
    "OUTPUT (truncated): " + toolOutput.slice(0, 300),
    "",
    "RULES TO CHECK:",
    checksText,
    "",
    "For each rule, did the tool call violate the SPIRIT of the rule?",
    "Most tool calls are fine — only flag genuine violations, not edge cases.",
    "",
    '{"violations": [{"rule": "rule-name", "violated": true/false, "reason": "one sentence"}], "any_violation": true/false}'
  ].join("\n");

  var result = haiku.call({
    prompt: prompt,
    caller: "spirit-check",
    jsonMode: true,
    maxTokens: 400,
    timeoutMs: 6000
  });

  if (!result.ok) {
    log({ result: "haiku_failed", error: result.error, ms: result.ms });
    return null; // fail-open
  }

  var parsed = result.parsed || {};
  if (!parsed.any_violation) {
    log({ result: "clean", tool: toolName, ms: result.ms, rules_checked: applicable.length });
    return null;
  }

  var violations = (parsed.violations || []).filter(function(v) { return v.violated; });
  if (violations.length === 0) return null;

  // Find most severe violation
  var best = null;
  for (var i = 0; i < violations.length; i++) {
    var rule = applicable.find(function(r) { return r.name === violations[i].rule; });
    var sev = rule ? rule.severity : "medium";
    if (sev === "high") { best = { v: violations[i], severity: "high" }; break; }
    if (!best) best = { v: violations[i], severity: sev };
  }
  if (!best) return null;

  log({
    result: "violation", tool: toolName,
    rule: best.v.rule, severity: best.severity,
    reason: best.v.reason, ms: result.ms
  });

  // Write analysis
  var analysis = [
    "# Spirit Violation Detected",
    "",
    "**Time:** " + new Date().toISOString(),
    "**Tool:** " + toolName,
    "**Rule:** " + best.v.rule,
    "**Severity:** " + best.severity,
    "",
    "## What happened",
    "`" + cmd.slice(0, 300) + "`",
    "",
    "## Violation",
    best.v.reason,
    "",
    "## Action required",
    "Undo or correct the action, then proceed.",
  ].join("\n");

  try { fs.writeFileSync(ANALYSIS_PATH, analysis, "utf-8"); } catch (e) {}

  // High severity → write state file (blocks next PreToolUse)
  if (best.severity === "high") {
    try {
      fs.writeFileSync(STATE_PATH, JSON.stringify({
        violation: true,
        timestamp: new Date().toISOString(),
        rule: best.v.rule,
        severity: best.severity,
        tool_name: toolName,
        tool_input: cmd.slice(0, 300),
        violation_description: best.v.reason,
        instructions: "Read ~/.claude/hooks/violation-analysis.md. Correct the issue before proceeding.",
        acknowledged: false
      }, null, 2), "utf-8");
    } catch (e) {}
  }

  return null; // PostToolUse never blocks — violation-gate.js does on next PreToolUse
};
