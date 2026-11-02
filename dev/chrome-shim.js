// Dev-only stand-in for the chrome.* APIs, so the settings page (dev/options-preview.html) and the content script and
// panel (dev/mock-youtube.html) run in a normal tab. Seeded with a demo key, a hidden log and usage. Scores come from
// a keyword "model" that answers after a delay, like the real one; a few videos count as cached and answer at once.
(function () {
  'use strict';
  const now = Date.now();
  const params = new URLSearchParams(location.search);
  const store = {
    'ytc:llm': { provider: 'openrouter', keys: { openrouter: 'sk-or-v1-demo-key-for-preview' }, models: { openrouter: 'deepseek/deepseek-v4.1-flash' } },
    'ytc:stats': { day: new Date().toLocaleDateString('en-CA'), calls: 23, videos: 412, tokensIn: 71000, tokensOut: 16400, tokensCached: 30000, cost: 0.0094, hidden: 37, shorts: 64 },
    'ytc:status': { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', error: null, at: now },
    'ytc:allow': { videos: {}, channels: { 'Calm Science (demo)': now } },
    'ytc:log': [
      { id: 'demo0000001', title: 'SHE DID WHAT?! 😱 Reacting to the CRAZIEST influencer drama of the week', channel: 'Drama Daily (demo)', duration: '18:02', v: 0, w: 'reaction to influencer drama, no substance', x: 1, at: now - 4 * 60000 },
      { id: 'demo0000002', title: 'I Spent 24 Hours Locked In A Supermarket', channel: 'Stunt House (demo)', duration: '21:40', v: 1, w: 'challenge stunt filler', x: 1, at: now - 25 * 60000 },
      { id: 'demo0000003', title: 'The Secret Billionaires Don’t Want You To Know', channel: 'Rich Mindset (demo)', duration: '9:12', v: 1, w: 'get-rich-quick hype, AI voiceover', x: 1, at: now - 3 * 3600000 },
      { id: 'demo0000004', title: 'Why Everyone Is Wrong About Black Holes', channel: 'Calm Science (demo)', duration: '16:30', v: 2, w: 'sensational framing, thin content', x: 1, at: now - 26 * 3600000 },
    ],
  };
  if (params.has('nokey')) store['ytc:llm'].keys.openrouter = '';
  const changeListeners = [];
  const messageListeners = [];

  const storage = {
    local: {
      async get(keys) {
        if (keys == null) return structuredClone(store);
        const out = {};
        for (const k of [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]);
        return out;
      },
      async set(items) {
        const changes = {};
        for (const k in items) {
          changes[k] = { oldValue: store[k], newValue: items[k] };
          store[k] = structuredClone(items[k]);
        }
        for (const fn of changeListeners) fn(changes, 'local');
      },
    },
    onChanged: { addListener: (fn) => changeListeners.push(fn) },
  };

  // Keyword "model": signal, music and a reason, from the title.
  const RULES = [
    [/highlights|vs .*\|| champion!/i, { v: 2, m: 0, w: 'sports highlights, nothing to learn' }],
    [/abridged|episode \d+ -/i, { v: 1, m: 0, w: 'anime parody, entertainment only' }],
    [/reacting|drama|exposed/i, { v: 0, m: 0, w: 'reaction drama, no substance' }],
    [/24 hours|challenge|prank/i, { v: 1, m: 0, w: 'stunt filler' }],
    [/secret|billionaires don/i, { v: 1, m: 0, w: 'get-rich-quick hype' }],
    [/official audio|live set|mix/i, { v: 1, m: 1, w: 'music' }],
    [/lecture|explained|history|how .* works|why /i, { v: 6, m: 0, w: 'solid explainer' }],
  ];
  function fakeScore(v) {
    for (const [re, sc] of RULES) if (re.test(v.title)) return Object.assign({ b: 3, x: 1 }, sc);
    return { v: 4, b: 2, m: 0, w: 'light but real', x: 0 };
  }
  const cached = new Set(['demovid0001', 'demovid0004', 'demovid0007']);

  function dispatch(msg) {
    for (const fn of messageListeners) fn(msg, {}, () => {});
  }

  function answer(msg) {
    if (msg.type === 'cacheCount') return { count: 1873 };
    if (msg.type === 'clearCache') return { cleared: 1873 };
    if (msg.type === 'score') {
      const hits = {};
      const later = [];
      for (const v of msg.videos) (cached.has(v.id) ? (hits[v.id] = fakeScore(v)) : later.push(v));
      // Two waves, like a first pass and a second look.
      const wave = (list, ms) =>
        setTimeout(() => {
          const scores = {};
          for (const v of list) scores[v.id] = fakeScore(v);
          if (list.length) dispatch({ type: 'scores', scores });
        }, ms);
      wave(later.filter((v) => fakeScore(v).v >= 5 || fakeScore(v).m), 1800);
      // ?slow makes the second look take longer than the content script's reveal wait.
      wave(later.filter((v) => !(fakeScore(v).v >= 5 || fakeScore(v).m)), params.has('slow') ? 7000 : 3600);
      return store['ytc:llm'].keys.openrouter ? { hits } : { hits, error: 'no_key' };
    }
    if (msg.type === 'test') {
      return {
        ok: true,
        ms: 2140,
        model: 'deepseek/deepseek-v4.1-flash',
        usage: { total: 1290, cost: 0.00011 },
        samples: [
          { title: 'Lecture 1: The Geometry of Linear Equations', channel: 'University Lectures (demo)', score: { v: 9, b: 0, m: 0, w: 'full university linear algebra lecture' } },
          { title: 'SHE DID WHAT?! 😱 Reacting to the CRAZIEST influencer drama of the week', channel: 'Drama Daily (demo)', score: { v: 0, b: 10, m: 0, w: 'reaction to influencer drama' } },
          { title: 'Why Nobody Can Explain This Simple Number (It Broke Mathematics)', channel: 'Science Explainers (demo)', score: { v: 6, b: 7, m: 0, w: 'baity title, likely real math explainer' } },
          { title: 'Midnight City (Official Audio)', channel: 'Synth Band (demo)', score: { v: 2, b: 0, m: 1, w: 'music track' } },
        ],
      };
    }
    return null;
  }

  const runtime = {
    id: 'dev-shim',
    lastError: null,
    sendMessage(msg, cb) {
      window.__ytcShimLog = (window.__ytcShimLog || []).concat(msg.type);
      const res = answer(msg);
      const delay = msg.type === 'test' ? 300 : 0;
      if (cb) return void setTimeout(() => cb(res), delay);
      return new Promise((r) => setTimeout(() => r(res), delay));
    },
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
  };

  window.chrome = { storage, runtime };
})();
