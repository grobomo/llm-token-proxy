#!/usr/bin/env node
"use strict";
// Shared Haiku caller for all gate modules.
// Calls the local proxy at :4100 (OpenAI-compatible endpoint).
// Copy this alongside any gate file.

var fs = require("fs");
var path = require("path");
var child_process = require("child_process");

var HOME = process.env.HOME || "/home/ubu";
var SETTINGS_PATH = path.join(HOME, ".claude", "settings.json");
var LOG_PATH = path.join(HOME, ".claude", "hooks", "hook-log.jsonl");

var DEFAULT_CONFIG = {
  proxyUrl: "http://127.0.0.1:4100/v1/chat/completions",
  model: "claude-4.5-haiku",
  maxTokens: 500,
  timeoutMs: 12000,
  curlTimeoutSec: 12
};

var _authCache = null;

function getAuth() {
  if (_authCache) return _authCache;
  if (process.env.LLM_PROXY_AUTH) {
    _authCache = process.env.LLM_PROXY_AUTH;
    return _authCache;
  }
  try {
    var settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    if (settings.env && settings.env.LLM_PROXY_AUTH) {
      _authCache = settings.env.LLM_PROXY_AUTH;
      return _authCache;
    }
  } catch (e) {}
  return "";
}

function logEntry(entry) {
  entry.ts = new Date().toISOString();
  if (!entry.module) entry.module = "haiku-client";
  try { fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8"); } catch (e) {}
}

function call(options) {
  if (!options || !options.prompt) {
    return { ok: false, error: "missing prompt", ms: 0 };
  }

  var model = options.model || DEFAULT_CONFIG.model;
  var maxTokens = options.maxTokens || DEFAULT_CONFIG.maxTokens;
  var timeoutMs = options.timeoutMs || DEFAULT_CONFIG.timeoutMs;
  var curlTimeout = Math.ceil(timeoutMs / 1000);
  var caller = options.caller || "haiku-client";
  var auth = getAuth();

  var messages = [];
  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }
  messages.push({ role: "user", content: options.prompt });

  var requestBody = JSON.stringify({
    model: model,
    messages: messages,
    max_tokens: maxTokens
  });

  var start = Date.now();
  var rawResponse;
  try {
    rawResponse = child_process.execSync(
      'curl -s --max-time ' + curlTimeout + ' ' + DEFAULT_CONFIG.proxyUrl +
      ' -H "Content-Type: application/json"' +
      ' -H "Authorization: Bearer ' + auth + '"' +
      ' -H "X-Task: ' + caller + '"' +
      ' -H "X-Project: hook-system"' +
      ' -d @-',
      { input: requestBody, encoding: "utf-8", timeout: timeoutMs + 2000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch (e) {
    var ms = Date.now() - start;
    logEntry({ module: caller, result: "haiku_fail", error: e.message.slice(0, 100), ms: ms });
    return { ok: false, error: "curl failed: " + e.message.slice(0, 100), ms: ms };
  }
  var ms = Date.now() - start;

  var content;
  try {
    var response = JSON.parse(rawResponse);
    if (response.error) {
      logEntry({ module: caller, result: "api_error", error: JSON.stringify(response.error).slice(0, 150), ms: ms });
      return { ok: false, error: "API error: " + JSON.stringify(response.error).slice(0, 150), ms: ms };
    }
    content = response.choices[0].message.content;
  } catch (e) {
    logEntry({ module: caller, result: "response_parse_fail", raw: rawResponse.slice(0, 200), ms: ms });
    return { ok: false, error: "response parse failed", ms: ms };
  }

  var parsed = null;
  if (options.jsonMode) {
    var jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (e) {}
    }
    if (!parsed) {
      logEntry({ module: caller, result: "json_parse_fail", raw: content.slice(0, 200), ms: ms });
      return { ok: false, error: "json parse failed in response", content: content, ms: ms };
    }
  }

  logEntry({ module: caller, result: "ok", ms: ms, model: model, contentLen: content.length });
  var result = { ok: true, content: content, ms: ms };
  if (parsed) result.parsed = parsed;
  return result;
}

function getConversationContext(transcriptPath, maxTurns) {
  maxTurns = maxTurns || 10;
  if (!transcriptPath) return "";
  try {
    if (!fs.existsSync(transcriptPath)) return "";
    var lines = fs.readFileSync(transcriptPath, "utf-8").trim().split("\n");
    var turns = [];
    var startIdx = Math.max(0, lines.length - (maxTurns * 6));
    for (var i = startIdx; i < lines.length && turns.length < maxTurns; i++) {
      try {
        var entry = JSON.parse(lines[i]);
        var type = entry.type || "";
        if (type !== "user" && type !== "assistant") continue;
        var msg = entry.message || {};
        var content = msg.content;
        var text = "";
        if (typeof content === "string") { text = content.slice(0, 250); }
        else if (Array.isArray(content)) {
          var parts = [];
          for (var j = 0; j < content.length; j++) {
            if (content[j] && content[j].type === "text" && content[j].text) {
              parts.push(content[j].text.slice(0, 200));
            }
          }
          text = parts.join(" ").slice(0, 250);
        }
        if (text) turns.push(type.toUpperCase() + ": " + text);
      } catch (e) {}
    }
    if (turns.length === 0) return "";
    return "RECENT CONVERSATION (" + turns.length + " turns):\n" + turns.join("\n");
  } catch (e) { return ""; }
}

module.exports = { call: call, getConversationContext: getConversationContext, DEFAULT_CONFIG: DEFAULT_CONFIG };

if (require.main === module) {
  var prompt = "";
  var args = process.argv.slice(2);
  for (var i = 0; i < args.length; i++) {
    if (args[i] === "--prompt" && args[i + 1]) { prompt = args[++i]; }
    else if (!args[i].startsWith("-")) { prompt = args[i]; }
  }
  if (!prompt) { try { prompt = fs.readFileSync(0, "utf-8").trim(); } catch (e) {} }
  if (!prompt) { process.stderr.write("Usage: echo 'prompt' | node haiku-client.js\n"); process.exit(1); }
  var result = call({ prompt: prompt, caller: "cli" });
  if (result.ok) { process.stdout.write(result.content + "\n"); }
  else { process.stderr.write("ERROR: " + result.error + "\n"); process.exit(1); }
}
