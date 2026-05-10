// TOOLS: Bash, Edit, Write
// WORKFLOW: wsl
// WHY: Haiku spirit-check (PostToolUse) detects violations but can't block.
// This gate reads the state file and blocks Opus on the NEXT tool call,
// forcing it to read the analysis and correct course.
//
// Flow: spirit-check.js writes violation-state.json → this gate reads it → blocks
// After block: sets acknowledged=true → next tool call proceeds.
"use strict";

var fs = require("fs");
var path = require("path");

var HOME = process.env.HOME || "/home/ubu";
var STATE_PATH = path.join(HOME, ".claude", "hooks", "violation-state.json");
var LOG_PATH = path.join(HOME, ".claude", "hooks", "hook-log.jsonl");

function log(entry) {
  entry.ts = new Date().toISOString();
  entry.module = "violation-gate";
  entry.event = "PreToolUse";
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8"); } catch (e) {}
}

module.exports = function(input) {
  var state;
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch (e) {
    return null; // no state file = no violation
  }

  if (!state.violation || state.acknowledged) {
    return null;
  }

  // Mark acknowledged so the NEXT tool call proceeds
  state.acknowledged = true;
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8"); } catch (e) {}

  log({ result: "block", rule: state.rule, severity: state.severity });

  return {
    decision: "block",
    reason: "SPIRIT VIOLATION: " + state.rule + "\n\n" +
      state.violation_description + "\n\n" +
      "Read ~/.claude/hooks/violation-analysis.md for details.\n" +
      "Correct the issue, then retry your tool call."
  };
};
