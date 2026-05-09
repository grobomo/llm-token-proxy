'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.ALERT_CONFIG || path.resolve(__dirname, '..', 'config.yaml');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    try { return require('js-yaml').load(raw); } catch {}
    // Fallback: extract alert_channel and webhook URLs with regex
    const channel = raw.match(/alert_channel:\s*(\w+)/)?.[1] || 'log';
    const slack = raw.match(/slack_webhook:\s*["']?([^"'\s]+)/)?.[1] || '';
    const webhook = raw.match(/webhook_url:\s*["']?([^"'\s]+)/)?.[1] || '';
    return { budget: { alert_channel: channel }, alerting: { slack_webhook: slack, webhook_url: webhook } };
  } catch {
    return {};
  }
}

function postJSON(url, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(parsed, { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

async function sendSlack(webhookUrl, message, opts = {}) {
  const payload = {
    text: message,
    username: opts.username || 'Token Proxy',
    icon_emoji: opts.icon || ':chart_with_upwards_trend:',
  };
  return postJSON(webhookUrl, payload);
}

async function sendWebhook(url, message, opts = {}) {
  const payload = {
    event: opts.event || 'alert',
    message,
    timestamp: new Date().toISOString(),
    source: 'token-proxy',
    ...opts.extra,
  };
  return postJSON(url, payload);
}

function sendLog(message) {
  const line = `[${new Date().toISOString()}] [ALERT] ${message}`;
  console.log(line);
  const logPath = path.resolve(__dirname, '..', 'data', 'alerts.log');
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + '\n');
  } catch {}
}

async function alert(message, opts = {}) {
  const config = loadConfig();
  const channels = opts.channels
    || (config.budget?.alert_channel ? [config.budget.alert_channel] : ['log']);

  const results = [];

  for (const channel of Array.isArray(channels) ? channels : [channels]) {
    try {
      switch (channel) {
        case 'slack': {
          const url = process.env.SLACK_WEBHOOK_URL || config.alerting?.slack_webhook;
          if (!url) { sendLog(`[slack] no webhook URL configured. Message: ${message}`); break; }
          const r = await sendSlack(url, message, opts);
          results.push({ channel: 'slack', status: r.status });
          break;
        }
        case 'webhook': {
          const url = process.env.ALERT_WEBHOOK_URL || config.alerting?.webhook_url;
          if (!url) { sendLog(`[webhook] no URL configured. Message: ${message}`); break; }
          const r = await sendWebhook(url, message, opts);
          results.push({ channel: 'webhook', status: r.status });
          break;
        }
        case 'log':
        default:
          sendLog(message);
          results.push({ channel: 'log', status: 'ok' });
          break;
      }
    } catch (err) {
      sendLog(`[${channel}] failed: ${err.message}. Original: ${message}`);
      results.push({ channel, status: 'error', error: err.message });
    }
  }

  return results;
}

module.exports = { alert, sendSlack, sendWebhook, sendLog };
