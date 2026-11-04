// Shared by the content script, background worker, settings page and tests.
// Plain script (no modules) so it can load everywhere: <script>, importScripts, manifest content_scripts, and Node.
(function (root) {
  'use strict';

  // The model gives each video a depth score from 0 to 10 (see prompt.js). The panel shows it as an IQ, the same
  // relabel X IQ Slider uses: 0 -> 70, 10 -> 150.
  const MAX_SCORE = 10;
  function iqOf(score) {
    return 70 + 8 * score;
  }

  // What the slider keeps at each setting: videos scoring at least `min` stay.
  const LEVELS = [
    { min: 0, blurb: 'Everything shows. No IQ filter' },
    { min: 1, blurb: 'Hides only the worst slop' },
    { min: 2, blurb: 'Hides slop: drama, reactions, pranks, content farms' },
    { min: 3, blurb: 'Also hides empty entertainment: highlights, playthroughs, vlogs' },
    { min: 4, blurb: 'Also hides commentary and light videos: sports talk, reviews, listicles' },
    { min: 5, blurb: 'Also hides popular stories: company sagas, scandals, true crime' },
    { min: 6, blurb: 'Ideas and depth: philosophy, science, essays that build an argument' },
    { min: 7, blurb: 'Deeper ideas and careful analysis only' },
    { min: 8, blurb: 'Deep only: expert lectures, rigorous conversations, technical deep dives' },
    { min: 9, blurb: 'Exceptional only: dense, original, worth taking notes on' },
    { min: 10, blurb: 'Only the very best' },
  ];

  // Topics the model picks one of for every video. `hint` goes into the prompt and the chip's tooltip.
  const TOPICS = [
    { key: 'science', label: 'Science', icon: '🔬', hint: 'natural sciences, space, maths, engineering, research' },
    { key: 'tech', label: 'Tech', icon: '💻', hint: 'gadgets, hardware, software products, the internet, the tech industry' },
    { key: 'ai', label: 'AI', icon: '🤖', hint: 'AI, machine learning, LLMs and AI products' },
    { key: 'programming', label: 'Coding', icon: '⌨️', hint: 'programming, software engineering, computer science' },
    { key: 'business', label: 'Business', icon: '📈', hint: 'startups, companies, markets, economics, investing, careers, personal finance' },
    { key: 'history', label: 'History', icon: '📜', hint: 'historical events, people, wars and civilizations' },
    { key: 'ideas', label: 'Ideas', icon: '💡', hint: 'philosophy, psychology, religion, ethics, big ideas, essays on society and culture' },
    { key: 'health', label: 'Health', icon: '🩺', hint: 'medicine, fitness, nutrition, sleep, mental health' },
    { key: 'politics', label: 'Politics', icon: '🏛️', hint: 'elections, policy, government, geopolitics, war, political commentary' },
    { key: 'news', label: 'News', icon: '📰', hint: 'current events and news reports that fit no other topic' },
    { key: 'arts', label: 'Arts & film', icon: '🎬', hint: 'film, TV, books, art, design, architecture, the craft and analysis of music' },
    { key: 'music', label: 'Music', icon: '🎵', hint: 'songs, music videos, live sets, mixes, background music' },
    { key: 'sports', label: 'Sports', icon: '⚽', hint: 'sport, matches, athletes, sports analysis' },
    { key: 'gaming', label: 'Gaming', icon: '🎮', hint: 'video games, playthroughs, esports, game analysis' },
    { key: 'comedy', label: 'Comedy', icon: '😂', hint: 'sketches, stand-up, parody, memes, funny compilations' },
    { key: 'lifestyle', label: 'Lifestyle', icon: '🌿', hint: 'food, cooking, travel, fashion, home, relationships, vlogs' },
    { key: 'drama', label: 'Drama', icon: '🍿', hint: 'celebrity and influencer gossip, feuds, drama and reaction videos' },
    { key: 'selfhelp', label: 'Self-help', icon: '🧭', hint: 'productivity, motivation, life advice, mindset' },
    { key: 'howto', label: 'How-to', icon: '🛠️', hint: 'tutorials and DIY outside coding: repairs, crafts, tools, practical skills' },
    { key: 'other', label: 'Other', icon: '💬', hint: 'anything else' },
  ];
  const TOPIC_KEYS = TOPICS.map((t) => t.key);
  // Topics marked "more" get a bar this many points lower (16 IQ). Topics marked "less" are always hidden.
  const MORE_EASE = 2;
  // A video scoring this close under its bar, on its title alone, gets a second look with its description.
  const SECOND_LOOK_RANGE = 3;

  const SETTINGS_VERSION = 2;
  const DEFAULT_SETTINGS = {
    v: SETTINGS_VERSION,
    enabled: true,
    hideShorts: true,
    minScore: 5, // the slider: videos scoring below this are hidden (IQ 110)
    topics: { drama: 'less' }, // topic key -> 'more' | 'less' | 'neutral'
    allowMusic: true,
    blurPending: true, // blur cards until they're judged
    showBadges: true, // IQ on each thumbnail
    takeOverMenu: true, // the panel gets YouTube's whole left menu, wider, with the sections below it hidden
    panelCollapsed: false,
    optionsOpen: false,
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
  const PROMPT_VERSION = 4;

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

  const PREFS = ['more', 'less', 'neutral'];

  function mergeSettings(stored) {
    stored = stored || {};
    const s = Object.assign({}, DEFAULT_SETTINGS, stored);
    s.surfaces = Object.assign({}, DEFAULT_SETTINGS.surfaces, stored.surfaces || {});
    // Stored choices (an explicit "neutral" included) win over the defaults.
    const topics = Object.assign({}, DEFAULT_SETTINGS.topics, stored.topics || {});
    s.topics = {};
    for (const k of TOPIC_KEYS) if (PREFS.includes(topics[k])) s.topics[k] = topics[k];
    // v1 had a 1-5 strictness that meant something else; start the IQ slider from its default.
    if (!stored.v || stored.v < 2) s.minScore = DEFAULT_SETTINGS.minScore;
    delete s.minSignal;
    s.minScore = clampInt(s.minScore, 0, MAX_SCORE);
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

  function levelOf(min) {
    return LEVELS[clampInt(min, 0, MAX_SCORE)];
  }

  function topicOf(key) {
    return TOPICS.find((t) => t.key === key) || TOPICS[TOPICS.length - 1];
  }

  function prefOf(settings, topic) {
    return settings.topics?.[topic] || 'neutral';
  }

  // The lowest score a video on this topic needs to stay.
  function barFor(score, settings) {
    return Math.max(0, settings.minScore - (prefOf(settings, score?.t) === 'more' ? MORE_EASE : 0));
  }

  // score: { v: depth 0-10, t: topic, b: bait 0-10, m: music 0/1, w: why, x: 0 title only | 1 looked twice | 2 no details }
  // returns { hide, reason: 'topic' | 'low' | null }
  function decide(score, settings, video, allow) {
    if (!score) return { hide: false, reason: null };
    if (allow && (allow.videos[video?.id] || (video?.channel && allow.channels[video.channel]))) return { hide: false, reason: null };
    if (prefOf(settings, score.t) === 'less') return { hide: true, reason: 'topic' };
    if (score.m && settings.allowMusic) return { hide: false, reason: null };
    if (score.v < barFor(score, settings)) return { hide: true, reason: 'low' };
    return { hide: false, reason: null };
  }

  // Judged on its title alone and only just under the bar: worth reading the description before hiding it.
  function wantsSecondLook(score, settings) {
    if (!score || score.x || score.m) return false;
    const bar = barFor(score, settings);
    return score.v < bar && score.v >= bar - SECOND_LOOK_RANGE;
  }

  // Which feed a page is, for the per-surface switches. Anything else (subscriptions, channels, playlists) is never filtered.
  function surfaceOf(pathname) {
    if (pathname === '/' || pathname === '/feed/recommended') return 'home';
    if (pathname === '/watch') return 'watch';
    if (pathname === '/results') return 'search';
    return null;
  }

  const api = {
    MAX_SCORE,
    LEVELS,
    TOPICS,
    TOPIC_KEYS,
    MORE_EASE,
    SECOND_LOOK_RANGE,
    DEFAULT_SETTINGS,
    PROVIDERS,
    DEFAULT_LLM,
    PROMPT_VERSION,
    STORAGE,
    iqOf,
    clampInt,
    hash,
    scoreSignature,
    mergeSettings,
    mergeLlm,
    mergeAllow,
    levelOf,
    topicOf,
    prefOf,
    barFor,
    decide,
    wantsSecondLook,
    surfaceOf,
  };

  root.YTC = Object.assign(root.YTC || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
