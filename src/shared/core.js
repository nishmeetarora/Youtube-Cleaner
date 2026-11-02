// Shared by the content script, background worker, settings page and tests.
// Plain script (no modules) so it can load everywhere: <script>, importScripts, manifest content_scripts, and Node.
(function (root) {
  'use strict';

  // Hide a video when its signal score is below the threshold. Scores are 0-10; see prompt.js for the bands.
  const STRICTNESS = [
    { min: 1, short: 'Worst only', label: 'Only the worst', blurb: 'Blatant slop: drama, reaction, pranks, content farms' },
    { min: 2, short: 'Slop', label: 'Slop', blurb: 'All slop, including hype and clip farms' },
    { min: 3, short: 'Slop + bait', label: 'Slop, bait and empty entertainment', blurb: 'Also clickbait with little in it, and highlights, episodes and playthroughs with nothing to learn (recommended)' },
    { min: 4, short: 'Strict', label: 'Strict', blurb: 'Also light videos: real but thin' },
    { min: 5, short: 'Very strict', label: 'Very strict', blurb: 'Only solid explanation, analysis and craft get through' },
  ];

  const SETTINGS_VERSION = 1;
  const DEFAULT_SETTINGS = {
    v: SETTINGS_VERSION,
    enabled: true,
    hideShorts: true,
    minSignal: 3,
    allowMusic: true,
    blurPending: true, // blur cards until they're judged
    panelCollapsed: false,
    surfaces: { home: true, watch: true, search: false },
  };

  // Both providers speak OpenAI-style /chat/completions. `reasoning` lists ways to turn thinking down,
  // tried in order; the last entry sends nothing. Classification doesn't need thinking, and it costs latency.
  const PROVIDERS = {
    openrouter: {
      label: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'deepseek/deepseek-v4.1-flash',
      models: [
        { id: 'deepseek/deepseek-v4.1-flash', note: 'DeepSeek V4.1 Flash · from $0.03/$0.08' },
        { id: 'xiaomi/mimo-v2.6-flash', note: 'MiMo V2.6 Flash · $0.14/$0.28' },
        { id: 'anthropic/claude-haiku-5.5', note: 'Claude Haiku 5.5 · $0.10/$0.50' },
        { id: 'openai/gpt-6-luna', note: 'GPT-6 Luna · $0.10/$0.50' },
        { id: 'google/gemini-3.1-flash-lite', note: 'Gemini 3.1 Flash Lite · $0.25/$1.50' },
      ],
      keyUrl: 'https://openrouter.ai/settings/keys',
      help: 'Pay-as-you-go credits. The usage panel below shows the real cost OpenRouter reports.',
      headers: { 'X-OpenRouter-Title': 'YouTube Cleaner', 'X-Title': 'YouTube Cleaner' },
      reasoning: [{ reasoning: { effort: 'none' } }, { reasoning: { effort: 'low' } }, {}],
    },
    'opencode-go': {
      label: 'OpenCode Go',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      defaultModel: 'deepseek-v4.1-flash',
      models: [
        { id: 'deepseek-v4.1-flash', note: 'DeepSeek V4.1 Flash · $0.15/$0.60 off-peak' },
        { id: 'mimo-v2.6-flash', note: 'MiMo V2.6 Flash · $0.14/$0.28' },
        { id: 'glm-5.3-flash', note: 'GLM 5.3 Flash · $0.15/$0.50' },
      ],
      keyUrl: 'https://opencode.ai/console',
      help: 'Uses your Go subscription’s per-model dollar limits. Only chat-completions models work here.',
      headers: {},
      sessionHeader: 'x-opencode-session',
      reasoning: [{ reasoning_effort: 'none' }, { reasoning_effort: 'low' }, {}],
    },
  };

  const DEFAULT_LLM = {
    provider: 'openrouter',
    keys: { openrouter: '', 'opencode-go': '' },
    models: { openrouter: PROVIDERS.openrouter.defaultModel, 'opencode-go': PROVIDERS['opencode-go'].defaultModel },
  };

  // Bump when the scoring prompt or score format changes so cached scores get redone.
  const PROMPT_VERSION = 2;

  const STORAGE = {
    settings: 'ytc:settings',
    llm: 'ytc:llm',
    stats: 'ytc:stats',
    status: 'ytc:status',
    log: 'ytc:log', // recently hidden videos, newest first
    allow: 'ytc:allow', // { videos: { id: at }, channels: { name: at } } the user chose to always show
    scorePrefix: 'sc:',
  };

  function clampInt(v, lo, hi) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
  }

  // Small stable string hash (djb2), used to tag cached scores with the prompt/model they came from.
  function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function scoreSignature(llm) {
    const provider = llm.provider;
    return hash([PROMPT_VERSION, provider, llm.models?.[provider] || ''].join('|'));
  }

  function mergeSettings(stored) {
    stored = stored || {};
    const s = Object.assign({}, DEFAULT_SETTINGS, stored);
    s.surfaces = Object.assign({}, DEFAULT_SETTINGS.surfaces, stored.surfaces || {});
    s.minSignal = clampInt(s.minSignal, STRICTNESS[0].min, STRICTNESS[STRICTNESS.length - 1].min);
    s.v = SETTINGS_VERSION;
    return s;
  }

  function mergeLlm(stored) {
    const l = Object.assign({}, DEFAULT_LLM, stored || {});
    l.keys = Object.assign({}, DEFAULT_LLM.keys, stored?.keys || {});
    l.models = Object.assign({}, DEFAULT_LLM.models, stored?.models || {});
    if (!PROVIDERS[l.provider]) l.provider = DEFAULT_LLM.provider;
    return l;
  }

  function mergeAllow(stored) {
    return { videos: Object.assign({}, stored?.videos), channels: Object.assign({}, stored?.channels) };
  }

  function strictnessOf(min) {
    return STRICTNESS.find((s) => s.min === min) || STRICTNESS[2];
  }

  // score: { v: signal 0-10, b: bait 0-10, m: music 0/1, w: why, x: 1 when it had a second look with details }
  // returns { hide, reason: 'low' | null }
  function decide(score, settings, video, allow) {
    if (!score) return { hide: false, reason: null };
    if (allow && (allow.videos[video?.id] || (video?.channel && allow.channels[video.channel]))) return { hide: false, reason: null };
    if (score.m && settings.allowMusic) return { hide: false, reason: null };
    if (score.v < settings.minSignal) return { hide: true, reason: 'low' };
    return { hide: false, reason: null };
  }

  // Which feed a page is, for the per-surface switches. Anything else (subscriptions, channels, playlists) is never filtered.
  function surfaceOf(pathname) {
    if (pathname === '/' || pathname === '/feed/recommended') return 'home';
    if (pathname === '/watch') return 'watch';
    if (pathname === '/results') return 'search';
    return null;
  }

  const api = {
    STRICTNESS,
    DEFAULT_SETTINGS,
    PROVIDERS,
    DEFAULT_LLM,
    PROMPT_VERSION,
    STORAGE,
    clampInt,
    hash,
    scoreSignature,
    mergeSettings,
    mergeLlm,
    mergeAllow,
    strictnessOf,
    decide,
    surfaceOf,
  };

  root.YTC = Object.assign(root.YTC || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
