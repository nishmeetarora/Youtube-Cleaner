// Calls the chosen provider's OpenAI-style /chat/completions endpoint and turns the reply into scores.
// Shared with IQ Slider for X.
// Optional request fields (JSON mode, thinking off, temperature) are dropped one by one if an endpoint rejects them,
// and what worked is remembered per model for the life of the worker.
(function (root) {
  'use strict';

  const SESSION_KEY = 'ytc:session';
  let sessionId = null;
  const quirks = new Map(); // "provider|model" -> { reasoning: index, json: bool, temperature: bool }

  class ApiError extends Error {
    constructor(message, status, retryable) {
      super(message);
      this.status = status;
      this.retryable = !!retryable;
    }
  }

  async function getSessionId() {
    if (sessionId) return sessionId;
    const got = await chrome.storage.local.get(SESSION_KEY);
    sessionId = got[SESSION_KEY];
    if (!sessionId) {
      sessionId = 'youtube-cleaner-' + crypto.randomUUID();
      await chrome.storage.local.set({ [SESSION_KEY]: sessionId });
    }
    return sessionId;
  }

  function serverMessage(text) {
    try {
      const j = JSON.parse(text);
      const m = j.error?.message || j.message || j.error?.type || (typeof j.error === 'string' ? j.error : '');
      if (m) return String(m);
    } catch (_) {}
    return String(text || '').slice(0, 160);
  }

  function errorFor(status, text) {
    const detail = serverMessage(text);
    const tail = detail ? `: ${detail.slice(0, 120)}` : '';
    if (status === 401 || status === 403) return new ApiError(`API key rejected (${status})${tail}`, status, false);
    if (status === 402) return new ApiError(`Out of credits (402)${tail}`, status, false);
    if (status === 404) return new ApiError(`Model or endpoint not found (404)${tail}`, status, false);
    if (status === 429) return new ApiError(`Rate or usage limit hit (429)${tail}`, status, true);
    if (status >= 500) return new ApiError(`Provider error (${status})${tail}`, status, true);
    return new ApiError(`API error ${status}${tail}`, status, false);
  }

  function contentOf(data) {
    const msg = data?.choices?.[0]?.message;
    if (!msg) return '';
    let c = msg.content;
    if (Array.isArray(c)) c = c.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
    if (c && String(c).trim()) return String(c);
    // Some reasoning models leave content empty and put everything in the reasoning field.
    return String(msg.reasoning_content || msg.reasoning || '');
  }

  async function chat(llm, messages, maxTokens) {
    const YTC = root.YTC;
    const provider = YTC.PROVIDERS[llm.provider];
    if (!provider) throw new ApiError(`Unknown provider ${llm.provider}`, 0, false);
    const key = llm.keys[llm.provider];
    const model = llm.models[llm.provider] || provider.defaultModel;
    const qk = `${llm.provider}|${model}`;
    const q = Object.assign({ reasoning: 0, json: true, temperature: true }, quirks.get(qk));
    const lastReasoning = provider.reasoning.length - 1;

    for (let attempt = 0; attempt < 6; attempt++) {
      const body = { model, messages, max_tokens: maxTokens, stream: false };
      if (q.temperature) body.temperature = 0;
      if (q.json) body.response_format = { type: 'json_object' };
      Object.assign(body, provider.reasoning[q.reasoning]);

      const headers = Object.assign({ 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, provider.headers);
      if (provider.sessionHeader) headers[provider.sessionHeader] = await getSessionId();

      let res;
      try {
        res = await fetch(`${provider.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
      } catch (e) {
        throw new ApiError(`Network error: ${e.message}`, 0, true);
      }
      if (res.ok) {
        quirks.set(qk, q);
        const data = await res.json().catch(() => null);
        if (!data) throw new ApiError('Provider sent a reply that is not JSON', res.status, true);
        return { data, model };
      }
      const text = await res.text().catch(() => '');
      if (res.status === 400 || res.status === 422) {
        // Drop whichever optional field the error mentions; if it names none, drop them in order.
        if (/reason|think|effort/i.test(text) && q.reasoning < lastReasoning) q.reasoning++;
        else if (/response_format|json_object|json mode/i.test(text) && q.json) q.json = false;
        else if (/temperature/i.test(text) && q.temperature) q.temperature = false;
        else if (q.reasoning < lastReasoning) q.reasoning++;
        else if (q.json) q.json = false;
        else if (q.temperature) q.temperature = false;
        else throw errorFor(res.status, text);
        continue;
      }
      throw errorFor(res.status, text);
    }
    throw new ApiError('Provider rejected every request shape', 400, false);
  }

  async function scoreBatch(llm, videos) {
    const YTC = root.YTC;
    const messages = YTC.prompt.buildMessages(videos);
    // Room for ~60 tokens per video, plus headroom in case the model thinks despite being asked not to.
    const maxTokens = 1500 + videos.length * 90;
    const { data, model } = await chat(llm, messages, maxTokens);
    const text = contentOf(data);
    const scores = YTC.prompt.parseScores(text, videos);
    if (!Object.keys(scores).length) {
      const finish = data?.choices?.[0]?.finish_reason;
      const why = finish === 'length' ? 'ran out of output tokens' : `reply wasn't the expected JSON: ${text.slice(0, 80) || '(empty)'}`;
      throw new ApiError(`Model ${why}`, 0, true);
    }
    const u = data.usage || {};
    return {
      scores,
      model: data.model || model,
      usage: {
        input: u.prompt_tokens || 0,
        output: u.completion_tokens || 0,
        // OpenAI-style field, or DeepSeek's own name for prompt-cache hits.
        cached: u.prompt_tokens_details?.cached_tokens || u.prompt_cache_hit_tokens || 0,
        cost: typeof u.cost === 'number' ? u.cost : 0,
      },
    };
  }

  root.YTC = Object.assign(root.YTC || {}, { providers: { scoreBatch, chat, ApiError } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
