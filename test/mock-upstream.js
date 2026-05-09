'use strict';

const express = require('express');

let responseOverride = null;

function setResponse(fn) { responseOverride = fn; }
function resetResponse() { responseOverride = null; }

function createMockUpstream(port = 14200) {
  const app = express();
  app.use(express.json());

  app.post('/v1/messages', (req, res) => {
    if (responseOverride) return responseOverride(req, res);

    const model = req.body.model || 'unknown';
    const messages = req.body.messages || [];
    const prompt = messages[0]?.content?.[0]?.text || messages[0]?.content || '';

    let text = `Mock response from ${model}`;
    if (prompt.includes('gate judge') || prompt.includes('JSON decision')) {
      const conf = prompt.includes('low-confidence') ? 0.4 : 0.9;
      text = JSON.stringify({ allow: true, reason: 'Mock decision', confidence: conf });
    } else if (req.body.system?.includes('confidence') || prompt.includes('confidence')) {
      const conf = prompt.includes('low-confidence') ? 0.3 : 0.85;
      text = JSON.stringify({ result: 'mock', confidence: conf });
    }

    res.json({
      id: 'msg_test_' + Date.now(),
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: 'end_turn',
    });
  });

  app.head('/', (req, res) => res.status(200).end());

  let server;
  return {
    start: () => new Promise(resolve => { server = app.listen(port, '127.0.0.1', () => resolve(server)); }),
    stop: () => new Promise(resolve => { server ? server.close(resolve) : resolve(); }),
    setResponse,
    resetResponse,
  };
}

module.exports = { createMockUpstream };
