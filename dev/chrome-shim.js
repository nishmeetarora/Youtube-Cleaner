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
      { id: 'demo0000001', title: 'SHE DID WHAT?! 😱 Reacting to the CRAZIEST influencer drama of the week', channel: 'Drama Daily (demo)', duration: '18:02', v: 0, w: 'reaction to influencer drama, no substance', t: 'drama', r: 'low', x: 1, at: now - 4 * 60000 },
      { id: 'demo0000002', title: 'I Spent 24 Hours Locked In A Supermarket', channel: 'Stunt House (demo)', duration: '21:40', v: 1, w: 'challenge stunt filler', t: 'lifestyle', r: 'low', x: 1, at: now - 25 * 60000 },
      { id: 'demo0000003', title: 'The Secret Billionaires Don’t Want You To Know', channel: 'Rich Mindset (demo)', duration: '9:12', v: 1, w: 'get-rich-quick hype, AI voiceover', t: 'business', r: 'low', x: 1, at: now - 3 * 3600000 },
      { id: 'demo0000004', title: 'Why Everyone Is Wrong About Black Holes', channel: 'Calm Science (demo)', duration: '16:30', v: 3, w: 'sensational framing, thin content', t: 'science', r: 'low', x: 1, at: now - 26 * 3600000 },
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

  // Keyword "model": depth, topic, music and a reason, from the title. First passes come back with x: 0.
  const RULES = [
    [/highlights|vs .*\|| champion!/i, { v: 2, t: 'sports', m: 0, w: 'sports highlights, nothing to learn' }],
    [/abridged|episode \d+ -/i, { v: 2, t: 'comedy', m: 0, w: 'anime parody, entertainment only' }],
    [/reacting|drama|exposed/i, { v: 1, t: 'drama', m: 0, w: 'reaction drama, no substance' }],
    [/24 hours|challenge|prank/i, { v: 1, t: 'lifestyle', m: 0, w: 'stunt filler' }],
    [/secret|billionaires don/i, { v: 1, t: 'business', m: 0, w: 'get-rich-quick hype' }],
    [/official audio|live set|mix/i, { v: 2, t: 'music', m: 1, w: 'music' }],
    [/lecture/i, { v: 8, t: 'ai', m: 0, w: 'full university lecture' }],
    [/economics of cloud/i, { v: 7, t: 'tech', m: 0, w: 'technical industry deep dive' }],
    [/history|silk road/i, { v: 6, t: 'history', m: 0, w: 'well-sourced history explainer' }],
    [/startup collapse/i, { v: 6, t: 'business', m: 0, w: 'financial post-mortem with numbers' }],
    [/black hole/i, { v: 5, t: 'science', m: 0, w: 'cosmology explainer' }],
    [/debt/i, { v: 5, t: 'politics', m: 0, w: 'public finance explained' }],
    [/cities/i, { v: 4, t: 'business', m: 0, w: 'urban economics, popular level' }],
    [/casually explained/i, { v: 3, t: 'comedy', m: 0, w: 'comedy with a few facts' }],
    [/new drivers/i, { v: 4, t: 'howto', m: 0, w: 'practical driving tips' }],
  ];
  function fakeScore(v) {
    for (const [re, sc] of RULES) if (re.test(v.title)) return Object.assign({ b: 3, x: 0 }, sc);
    return { v: 4, t: 'other', b: 2, m: 0, w: 'light but real', x: 0 };
  }
  // The second look, with the description: a few videos turn out better than their titles.
  function secondLook(v) {
    const sc = fakeScore(v);
    const lift = /cities|new drivers/i.test(v.title) ? 1 : 0;
    return Object.assign({}, sc, { v: sc.v + lift, w: lift ? `${sc.w}; description shows more depth` : sc.w, x: 1 });
  }
  const cached = new Set(['demovid0001', 'demovid0004', 'demovid0007']);
  const looked = new Set();

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
      if (!store['ytc:llm'].keys.openrouter) return { hits, error: 'no_key' };
      setTimeout(() => {
        const scores = {};
        for (const v of later) scores[v.id] = fakeScore(v);
        if (later.length) dispatch({ type: 'scores', scores });
      }, 1500);
      return { hits };
    }
    if (msg.type === 'recheck') {
      window.__ytcRechecks = (window.__ytcRechecks || []).concat(msg.videos.map((v) => v.id));
      const hits = {};
      const queued = [];
      for (const v of msg.videos) (looked.has(v.id) ? (hits[v.id] = secondLook(v)) : queued.push(v));
      // ?slow makes the second look take longer than the content script's reveal wait.
      setTimeout(() => {
        const scores = {};
        for (const v of queued) {
          looked.add(v.id);
          scores[v.id] = secondLook(v);
        }
        if (queued.length) dispatch({ type: 'scores', scores });
      }, params.has('slow') ? 7000 : 1500);
      return { hits, queued: queued.map((v) => v.id) };
    }
    if (msg.type === 'test') {
      return {
        ok: true,
        ms: 2140,
        model: 'deepseek/deepseek-v4.1-flash',
        usage: { total: 1290, cost: 0.00011 },
        samples: [
          { title: 'Lecture 1: The Geometry of Linear Equations', channel: 'University Lectures (demo)', score: { v: 9, t: 'science', b: 0, m: 0, w: 'full university linear algebra lecture' } },
          { title: 'SHE DID WHAT?! 😱 Reacting to the CRAZIEST influencer drama of the week', channel: 'Drama Daily (demo)', score: { v: 0, t: 'drama', b: 10, m: 0, w: 'reaction to influencer drama' } },
          { title: 'Why Nobody Can Explain This Simple Number (It Broke Mathematics)', channel: 'Science Explainers (demo)', score: { v: 6, t: 'science', b: 7, m: 0, w: 'baity title, likely real math explainer' } },
          { title: 'Midnight City (Official Audio)', channel: 'Synth Band (demo)', score: { v: 2, t: 'music', b: 0, m: 1, w: 'music track' } },
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
