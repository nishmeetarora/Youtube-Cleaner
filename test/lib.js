// Shared helpers for the accuracy test: .env loading, data files, and LLM calls through the same
// OpenAI-style providers X IQ Slider uses. Optional request fields are dropped if a provider rejects them.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(__dirname, 'data');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

function readData(name) {
  const file = path.join(DATA, name);
  if (!fs.existsSync(file)) throw new Error(`Missing test/data/${name}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeData(name, value) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, name), JSON.stringify(value, null, 2));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs fn over items with at most `limit` in flight, keeping results in order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const PROVIDERS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v4.1-flash',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: { 'X-Title': 'YouTube Cleaner accuracy test' },
    reasoning: [{ reasoning: { effort: 'none' } }, { reasoning: { effort: 'low' } }, {}],
  },
  'opencode-go': {
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    defaultModel: 'deepseek-v4.1-flash',
    keyEnv: 'OPENCODE_API_KEY',
    headers: {},
    reasoning: [{ reasoning_effort: 'none' }, { reasoning_effort: 'low' }, {}],
  },
};

function llmConfig() {
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    const key = process.env[provider.keyEnv];
    if (key) return { id, provider, key, model: process.env.LLM_MODEL || provider.defaultModel };
  }
  throw new Error('Add OPENROUTER_API_KEY or OPENCODE_API_KEY to .env');
}

async function chat(llm, messages, maxTokens) {
  const q = { reasoning: 0, json: true };
  const last = llm.provider.reasoning.length - 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const body = { model: llm.model, messages, max_tokens: maxTokens, temperature: 0, stream: false };
    if (q.json) body.response_format = { type: 'json_object' };
    Object.assign(body, llm.provider.reasoning[q.reasoning]);
    const res = await fetch(`${llm.provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${llm.key}` }, llm.provider.headers),
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const text = await res.text().catch(() => '');
    if (res.status === 400 || res.status === 422) {
      if (/reason|think|effort/i.test(text) && q.reasoning < last) q.reasoning++;
      else if (/response_format|json/i.test(text) && q.json) q.json = false;
      else if (q.reasoning < last) q.reasoning++;
      else if (q.json) q.json = false;
      else throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
  }
  throw new Error('LLM kept failing');
}

function contentOf(data) {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return '';
  let c = msg.content;
  if (Array.isArray(c)) c = c.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  return String(c || msg.reasoning_content || msg.reasoning || '');
}

// Finds the result list in a reply, tolerating code fences, prose around the JSON, and truncation.
function extractList(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  for (const c of [cleaned, start >= 0 && end > start ? cleaned.slice(start, end + 1) : '']) {
    try {
      const j = JSON.parse(c);
      const list = Array.isArray(j) ? j : j.r || j.results || j.videos;
      if (Array.isArray(list)) return list;
    } catch (_) {}
  }
  const partial = [];
  for (const m of cleaned.match(/\{[^{}]*"i"\s*:\s*\d+[^{}]*\}/g) || []) {
    try {
      partial.push(JSON.parse(m));
    } catch (_) {}
  }
  return partial;
}

module.exports = { ROOT, DATA, loadEnv, readData, writeData, sleep, mapLimit, llmConfig, chat, contentOf, extractList };
