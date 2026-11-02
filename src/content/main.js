// Content script: judges the video cards on screen and runs the control panel in YouTube's menu.
// The hook sends the videos in each feed; this asks the background for their scores and marks every card: blurred
// while it's judged (by CSS, until marked), shown, or hidden with display: none so the grid closes up. Hiding happens
// here rather than in YouTube's data, so the panel's slider takes effect instantly in both directions.
// It also fetches details for the background's second look, because YouTube only answers those from its own origin.
(function () {
  'use strict';
  const YTC = globalThis.YTC;
  const { STORAGE } = YTC;

  const CONFIG_KEY = 'ytc-config';
  const GRACE_MS = 1500; // a card the hook never sent is judged from the card itself after this
  const PENDING_TIMEOUT = 15000; // stop waiting for a score; the card shows unjudged
  const REVEAL_WAIT_MS = 4000; // an undecided card holds back the cards after it for at most this long
  const LOG_DELAY = 3000; // hidden videos are logged once the settings have stayed put this long
  const ID = /^[\w-]{11}$/;
  const FALLBACK_CLIENT = '2.20251030.01.00';

  // Cards per feed. On Home the grid tile is the card.
  const CARDS = {
    home: 'ytd-browse[page-subtype="home"] ytd-rich-item-renderer',
    watch: 'ytd-watch-next-secondary-results-renderer yt-lockup-view-model, ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer',
    search: 'ytd-search ytd-video-renderer',
  };

  let settings = YTC.mergeSettings(null);
  let allow = YTC.mergeAllow(null);
  let hasKey = false;
  let status = {};
  let ready = false;
  let clientVersion = FALLBACK_CLIENT;
  let lastLocalUpdate = 0;
  let llmError = null;
  const early = []; // hook messages that arrive before settings load

  const videos = new Map(); // id -> { id, title, channel, duration, views, age }
  const scores = new Map(); // id -> { v, b, m, w, x }
  const requested = new Map(); // id -> when its score was asked for
  const failed = new Set();
  const firstSeen = new Map(); // id -> when a card for it first appeared
  const logged = new Set();
  const toLog = new Set();
  let pageStats = emptyStats(null);

  function emptyStats(surface) {
    return { surface, active: false, hasKey, judged: 0, hidden: 0, pending: 0, dist: new Array(6).fill(0), hiddenList: [], error: llmError };
  }

  function contextAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      if (!contextAlive()) return reject(new Error('Extension was reloaded; refresh the page'));
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function toPage(msg) {
    window.postMessage(Object.assign({ __ytc: 'content' }, msg), location.origin);
  }

  function active(surface) {
    return !!(settings.enabled && hasKey && surface && settings.surfaces[surface]);
  }

  function pushConfig() {
    const blur = settings.blurPending ? Object.keys(CARDS).filter(active) : [];
    const config = { enabled: settings.enabled, hideShorts: settings.hideShorts, surfaces: settings.surfaces, blur };
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (_) {}
    toPage({ kind: 'config', config });
    const html = document.documentElement;
    if (!html) return;
    html.toggleAttribute('data-ytc-shorts', !!settings.hideShorts);
    if (blur.length) html.setAttribute('data-ytc-blur', blur.join(' '));
    else html.removeAttribute('data-ytc-blur');
  }

  const str = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  function cleanVideo(v) {
    if (!v || typeof v !== 'object' || !ID.test(v.id) || typeof v.title !== 'string') return null;
    return { id: v.id, title: str(v.title, 200), channel: str(v.channel, 100), duration: str(v.duration, 12), views: str(v.views, 30), age: str(v.age, 40) };
  }

  // ---------------- Scoring ----------------

  function request(list) {
    const now = Date.now();
    const todo = list.filter((v) => !scores.has(v.id) && !requested.has(v.id) && !failed.has(v.id));
    if (!todo.length) return;
    for (const v of todo) requested.set(v.id, now);
    send({ type: 'score', videos: todo })
      .then((res) => {
        if (!res) return;
        if (res.hits) applyScores(res.hits);
        if (res.error) {
          llmError = res.error;
          markFailed(todo.map((v) => v.id).filter((id) => !scores.has(id)));
        }
      })
      .catch(() => markFailed(todo.map((v) => v.id)));
  }

  function applyScores(map) {
    let changed = false;
    for (const id in map) {
      if (!map[id]) continue;
      scores.set(id, map[id]);
      failed.delete(id);
      changed = true;
    }
    if (changed) {
      if (llmError && llmError !== 'no_key') llmError = null;
      scheduleDom(0);
    }
  }

  function markFailed(ids, error) {
    for (const id of ids) if (!scores.has(id)) failed.add(id);
    if (error) llmError = error;
    scheduleDom(0);
  }

  function onVideos(m) {
    if (typeof m.client === 'string' && /^\d+\.\d{8}\.\d{2}\.\d{2}$/.test(m.client)) clientVersion = m.client;
    const list = (Array.isArray(m.videos) ? m.videos : []).slice(0, 300).map(cleanVideo).filter(Boolean);
    for (const v of list) if (!videos.has(v.id)) videos.set(v.id, v);
    if (active(m.surface)) request(list);
    scheduleDom();
  }

  // ---------------- Cards ----------------

  // Mixes and playlists link with &list= and aren't judged.
  function cardVideoId(card) {
    const a = card.querySelector('a[href*="/watch?v="]');
    const href = a && a.getAttribute('href');
    if (!href || /[?&]list=/.test(href)) return null;
    const m = href.match(/[?&]v=([\w-]{11})/);
    return m ? m[1] : null;
  }

  // For a card the hook never sent (YouTube re-rendered from its own cache): read what the card shows.
  function videoFromCard(card, id) {
    const title = str(card.querySelector('h3, #video-title')?.textContent, 200);
    if (!title) return null;
    const channel = str(card.querySelector('ytd-channel-name a, ytd-channel-name #text, [class*="metadata-row"] a, [class*="metadata-row"] span')?.textContent, 100);
    return { id, title, channel, duration: '', views: '', age: '' };
  }

  // 'ok', 'hidden', 'pending', or 'unasked' for a video whose score nobody has asked for yet.
  function verdict(id, now) {
    if (!id) return 'ok';
    const sc = scores.get(id);
    if (sc) return YTC.decide(sc, settings, videos.get(id), allow).hide ? 'hidden' : 'ok';
    if (failed.has(id)) return 'ok';
    const asked = requested.get(id);
    if (asked) {
      if (now - asked < PENDING_TIMEOUT) return 'pending';
      failed.add(id);
      return 'ok';
    }
    // The hook usually sends a video before its card renders; give it a moment before reading the card instead.
    if (!videos.has(id) && now - (firstSeen.get(id) || now) < GRACE_MS) return 'pending';
    return 'unasked';
  }

  function mark(card, state) {
    const ok = state !== 'hidden' && state !== 'pending';
    const hidden = state === 'hidden';
    if (card.hasAttribute('data-ytc-ok') !== ok) card.toggleAttribute('data-ytc-ok', ok);
    if (card.hasAttribute('data-ytc-hidden') !== hidden) card.toggleAttribute('data-ytc-hidden', hidden);
  }

  let recheckTimer = null;
  function domPass() {
    const now = Date.now();
    const here = YTC.surfaceOf(location.pathname);
    const stats = emptyStats(here);
    stats.active = active(here);
    const counted = new Set();
    const fromCards = [];
    let waiting = false;

    for (const [surface, selector] of Object.entries(CARDS)) {
      const on = active(surface);
      // Cards are revealed in reading order: one stays blurred until every card before it is decided, so a hidden
      // card never makes something you can already see move. A card that takes long (a second look) stops holding
      // the rest back after REVEAL_WAIT_MS, so one slow video can't keep the whole page blurred.
      let blocked = false;
      for (const card of document.querySelectorAll(selector)) {
        const id = cardVideoId(card);
        if (id && !firstSeen.has(id)) firstSeen.set(id, now);
        let state = on ? verdict(id, now) : 'off';
        if (state === 'unasked') {
          const v = videos.get(id) || videoFromCard(card, id);
          if (v) {
            videos.set(id, v);
            fromCards.push(v);
            state = 'pending';
          } else {
            failed.add(id);
            state = 'ok';
          }
        }
        if (state === 'pending') waiting = true;
        mark(card, blocked && state === 'ok' && settings.blurPending ? 'pending' : state);
        if (state === 'pending' && now - (firstSeen.get(id) || now) < REVEAL_WAIT_MS) blocked = true;
        if (state === 'hidden') toLog.add(id);
        if (surface !== here || !on || !id || counted.has(id)) continue;
        counted.add(id);
        const sc = scores.get(id);
        if (state === 'pending') stats.pending++;
        if (!sc) continue;
        stats.judged++;
        if (!(sc.m && settings.allowMusic)) stats.dist[Math.min(sc.v, 5)]++;
        if (state === 'hidden') {
          stats.hidden++;
          const v = videos.get(id) || {};
          stats.hiddenList.push({ id, title: v.title, channel: v.channel, v: sc.v, why: sc.w });
        }
      }
    }
    if (fromCards.length) request(fromCards);
    pageStats = stats;
    panel.ensure();
    panel.renderStats();
    if (toLog.size) scheduleLog(false);
    clearTimeout(recheckTimer);
    if (waiting) recheckTimer = setTimeout(() => scheduleDom(0), 1000);
  }

  let domTimer = null;
  function scheduleDom(delay) {
    if (domTimer) {
      if (delay !== 0) return;
      clearTimeout(domTimer);
    }
    domTimer = setTimeout(() => {
      domTimer = null;
      if (contextAlive()) domPass();
      else shutDown();
    }, delay ?? 120);
  }

  // The extension was reloaded or removed: leave the page as YouTube made it.
  function shutDown() {
    observer?.disconnect();
    document.documentElement?.removeAttribute('data-ytc-blur');
    for (const card of document.querySelectorAll('[data-ytc-ok], [data-ytc-hidden]')) {
      card.removeAttribute('data-ytc-ok');
      card.removeAttribute('data-ytc-hidden');
    }
    panel.el.remove();
  }

  // ---------------- Hidden log, once the settings have settled ----------------

  // A setting change restarts the wait, so dragging the slider through strict values logs nothing.
  let logTimer = null;
  function scheduleLog(restart) {
    if (logTimer && !restart) return;
    clearTimeout(logTimer);
    logTimer = setTimeout(() => {
      logTimer = null;
      const now = Date.now();
      for (const id of toLog) {
        if (logged.has(id) || verdict(id, now) !== 'hidden') continue;
        logged.add(id);
        const v = videos.get(id);
        if (v) send({ type: 'hidden', video: v, score: scores.get(id) }).catch(() => {});
      }
      toLog.clear();
    }, LOG_DELAY);
  }

  let shortsPending = 0;
  let shortsTimer = null;
  function countShorts(n) {
    shortsPending += Math.max(0, Math.min(500, Number(n) || 0));
    if (shortsTimer) return;
    shortsTimer = setTimeout(() => {
      shortsTimer = null;
      const count = shortsPending;
      shortsPending = 0;
      if (count) send({ type: 'shorts', count }).catch(() => {});
    }, 2000);
  }

  // ---------------- Details for the second look ----------------

  async function fetchDetails(id) {
    try {
      const res = await fetch('/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en' } }, videoId: id }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      const vd = j.videoDetails;
      if (!vd) return null;
      const mf = j.microformat?.playerMicroformatRenderer || {};
      return {
        description: String(vd.shortDescription || '').slice(0, 3000),
        tags: (Array.isArray(vd.keywords) ? vd.keywords : []).slice(0, 15).map((t) => str(t, 40)),
        category: str(mf.category, 40),
      };
    } catch (_) {
      return null;
    }
  }

  async function detailsFor(ids) {
    const out = {};
    const list = ids.filter((id) => ID.test(id)).slice(0, 40);
    let next = 0;
    async function worker() {
      while (next < list.length) {
        const id = list[next++];
        const d = await fetchDetails(id);
        if (d) out[id] = d;
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    return out;
  }

  // ---------------- Settings and the panel ----------------

  let saveTimer = null;
  function update(patch) {
    settings = YTC.mergeSettings(Object.assign({}, settings, patch));
    lastLocalUpdate = Date.now();
    pushConfig();
    panel.render();
    scheduleDom(0);
    if (logTimer) scheduleLog(true);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (contextAlive()) chrome.storage.local.set({ [STORAGE.settings]: settings });
    }, 300);
  }

  function allowVideo(id) {
    allow = YTC.mergeAllow(allow);
    allow.videos[id] = Date.now();
    if (contextAlive()) chrome.storage.local.set({ [STORAGE.allow]: allow });
    scheduleDom(0);
  }

  const panel = YTC.createPanel({
    getSettings: () => settings,
    getPageStats: () => Object.assign({}, pageStats, { hasKey, error: llmError }),
    getStatus: () => status,
    update,
    allowVideo,
    openSettings: () => send({ type: 'openOptions' }).catch(() => {}),
  });

  function readStatus(got) {
    const s = got[STORAGE.status] || {};
    const today = new Date().toLocaleDateString('en-CA');
    const stats = got[STORAGE.stats];
    status = { model: s.model, error: s.error, cost: stats && stats.day === today ? stats.cost : 0 };
  }

  // ---------------- Wiring ----------------

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ytc !== 'page') return;
    const m = e.data;
    if (!ready) return void early.push(m);
    if (m.kind === 'videos') onVideos(m);
    else if (m.kind === 'shorts') countShorts(m.count);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'scores') applyScores(msg.scores || {});
    else if (msg.type === 'scoreError') markFailed(msg.ids || [], msg.error);
    else if (msg.type === 'details') {
      detailsFor(Array.isArray(msg.ids) ? msg.ids : []).then((details) => sendResponse({ details }));
      return true;
    }
  });

  function readKey(stored) {
    const llm = YTC.mergeLlm(stored);
    return !!llm.keys[llm.provider];
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let dom = false;
    if (changes[STORAGE.settings] && Date.now() - lastLocalUpdate > 1500) {
      settings = YTC.mergeSettings(changes[STORAGE.settings].newValue);
      pushConfig();
      panel.render();
      dom = true;
    }
    if (changes[STORAGE.allow]) {
      allow = YTC.mergeAllow(changes[STORAGE.allow].newValue);
      dom = true;
    }
    if (changes[STORAGE.llm]) {
      hasKey = readKey(changes[STORAGE.llm].newValue);
      failed.clear();
      requested.clear();
      llmError = null;
      pushConfig();
      dom = true;
    }
    if (changes[STORAGE.status] || changes[STORAGE.stats]) {
      chrome.storage.local.get([STORAGE.status, STORAGE.stats]).then((got) => {
        readStatus(got);
        panel.renderStats();
      });
    }
    if (dom) scheduleDom(0);
  });

  let observer = null;
  chrome.storage.local.get([STORAGE.settings, STORAGE.allow, STORAGE.llm, STORAGE.status, STORAGE.stats]).then((got) => {
    settings = YTC.mergeSettings(got[STORAGE.settings]);
    allow = YTC.mergeAllow(got[STORAGE.allow]);
    hasKey = readKey(got[STORAGE.llm]);
    readStatus(got);
    ready = true;
    pushConfig();
    for (const m of early.splice(0)) {
      if (m.kind === 'videos') onVideos(m);
      else if (m.kind === 'shorts') countShorts(m.count);
    }
    panel.render();
    // Recycled cards change their link rather than their children, so hrefs are watched too.
    observer = new MutationObserver(() => scheduleDom());
    const start = () => {
      pushConfig();
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
      scheduleDom(0);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  });
})();
