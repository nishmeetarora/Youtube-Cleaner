// Background worker: batches videos from open YouTube tabs, scores them with the chosen model, caches and returns
// the scores. A tab asks for a second look (a "recheck") at a video whose title-only score lands just under the
// viewer's IQ bar; that video is judged again with its description, tags and chapters, so a good video with a
// clickbait title isn't hidden on the title alone.
importScripts('../shared/core.js', 'prompt.js', 'cache.js', 'providers.js');

const { STORAGE } = YTC;

// Bigger batches mean fewer calls, so the fixed system prompt is paid for less often.
// A feed page (~20-30 videos) arrives at once and gets split into even batches of at most MAX_BATCH.
const MAX_BATCH = 24;
const BATCH_DELAY_MS = 300;
const MAX_IN_FLIGHT = 3;
const MAX_ATTEMPTS = 2;
const DETAILS_TIMEOUT_MS = 8000;
const LOG_SIZE = 300;

const queue = []; // videos waiting for a first-pass batch
const recheckQueue = []; // videos waiting for a second look
const waiting = new Map(); // video id -> Set of tab ids that want its score
const attempts = new Map(); // video id -> how many batches it has been in
let inFlight = 0;
let timer = null;

async function getLlm() {
  const got = await chrome.storage.local.get(STORAGE.llm);
  return YTC.mergeLlm(got[STORAGE.llm]);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === 'score') {
    handleScore(msg.videos || [], tabId).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'recheck') {
    handleRecheck(msg.videos || [], tabId).then(sendResponse, (e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === 'hidden') {
    recordHidden(msg.video, msg.score, msg.reason);
    return;
  }
  if (msg.type === 'shorts') {
    recordShorts(msg.count);
    return;
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (msg.type === 'test') {
    testConnection(YTC.mergeLlm(msg.llm)).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'clearCache') {
    YTC.cache.clear().then((cleared) => sendResponse({ cleared }));
    return true;
  }
  if (msg.type === 'cacheCount') {
    YTC.cache.count().then((count) => sendResponse({ count }));
    return true;
  }
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onInstalled.addListener((details) => {
  YTC.cache.prune();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => YTC.cache.prune());

const ID = /^[\w-]{11}$/;
const str = (s, n) => String(s ?? '').slice(0, n);

function cleanVideo(v) {
  if (!v || typeof v !== 'object' || !ID.test(v.id)) return null;
  return { id: v.id, title: str(v.title, 200), channel: str(v.channel, 100), duration: str(v.duration, 12), views: str(v.views, 30), age: str(v.age, 40) };
}

async function handleScore(videos, tabId) {
  videos = videos.map(cleanVideo).filter(Boolean);
  const llm = await getLlm();
  const sig = YTC.scoreSignature(llm);
  const hits = await YTC.cache.getMany(
    videos.map((v) => v.id),
    sig
  );
  if (!llm.keys[llm.provider]) return { hits, error: 'no_key' };
  for (const v of videos) {
    if (hits[v.id]) continue;
    let tabs = waiting.get(v.id);
    if (!tabs) {
      tabs = new Set();
      waiting.set(v.id, tabs);
      queue.push(v);
    }
    if (tabId != null) tabs.add(tabId);
  }
  pump();
  return { hits };
}

// Videos already looked at twice come straight from the cache; the rest wait for a second-look batch. A video
// with no first-pass score in the cache (cleared meanwhile) has nothing to recheck and is dropped.
async function handleRecheck(videos, tabId) {
  videos = videos.map(cleanVideo).filter(Boolean);
  const llm = await getLlm();
  const sig = YTC.scoreSignature(llm);
  const cached = await YTC.cache.getMany(
    videos.map((v) => v.id),
    sig
  );
  const hits = {};
  const queued = [];
  for (const v of videos) {
    const sc = cached[v.id];
    if (!sc) continue;
    if (sc.x) {
      hits[v.id] = sc;
      continue;
    }
    if (!llm.keys[llm.provider]) continue;
    queued.push(v.id);
    let tabs = waiting.get(v.id);
    if (!tabs) {
      tabs = new Set();
      waiting.set(v.id, tabs);
      recheckQueue.push(Object.assign(v, { first: sc }));
    }
    if (tabId != null) tabs.add(tabId);
  }
  pump();
  return { hits, queued };
}

// Splits a queue into even batches: 30 waiting -> 15 + 15, not 24 + 6.
function nextBatch(q) {
  const chunks = Math.ceil(q.length / MAX_BATCH);
  return q.splice(0, Math.ceil(q.length / chunks));
}

// First passes go before second looks: an unjudged card is blurred, a rechecked one is only waiting to be sure.
function flush() {
  while (inFlight < MAX_IN_FLIGHT && (queue.length || recheckQueue.length)) {
    if (queue.length) runBatch(nextBatch(queue));
    else runRecheck(nextBatch(recheckQueue));
  }
}

function pump() {
  if (queue.length >= MAX_BATCH || recheckQueue.length >= MAX_BATCH) flush();
  if ((queue.length || recheckQueue.length) && inFlight < MAX_IN_FLIGHT && !timer) {
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, BATCH_DELAY_MS);
  }
}

function groupByTab(ids) {
  const byTab = new Map();
  for (const id of ids) {
    for (const tab of waiting.get(id) || []) {
      if (!byTab.has(tab)) byTab.set(tab, []);
      byTab.get(tab).push(id);
    }
  }
  return byTab;
}

function deliver(scores) {
  const ids = Object.keys(scores);
  for (const [tab, tabIds] of groupByTab(ids)) {
    const subset = {};
    for (const id of tabIds) subset[id] = scores[id];
    chrome.tabs.sendMessage(tab, { type: 'scores', scores: subset }).catch(() => {});
  }
  for (const id of ids) {
    waiting.delete(id);
    attempts.delete(id);
  }
}

function fail(ids, error) {
  for (const [tab, tabIds] of groupByTab(ids)) {
    chrome.tabs.sendMessage(tab, { type: 'scoreError', ids: tabIds, error }).catch(() => {});
  }
  for (const id of ids) {
    waiting.delete(id);
    attempts.delete(id);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scoreWithRetry(llm, videos) {
  try {
    return await YTC.providers.scoreBatch(llm, videos);
  } catch (e) {
    if (!e.retryable) throw e;
    await sleep(e.status === 429 ? 4000 : 1500);
    return YTC.providers.scoreBatch(llm, videos);
  }
}

// YouTube answers details requests only from its own origin, so a tab that wants these videos fetches them.
async function fetchDetails(ids) {
  const out = {};
  for (const [tab, tabIds] of groupByTab(ids)) {
    const todo = tabIds.filter((id) => !out[id]);
    if (!todo.length) continue;
    try {
      const res = await Promise.race([
        chrome.tabs.sendMessage(tab, { type: 'details', ids: todo }),
        sleep(DETAILS_TIMEOUT_MS).then(() => null),
      ]);
      Object.assign(out, res?.details || {});
    } catch (_) {}
  }
  return out;
}

// Judges videos again with their details. A video whose details couldn't be fetched keeps its title-only score,
// marked x: 2 so nobody asks again; one the model skipped or failed on keeps it unmarked, to be tried another time.
async function runRecheck(videos) {
  inFlight++;
  let llm = null;
  const final = {};
  for (const v of videos) final[v.id] = Object.assign({}, v.first, { x: 2 });
  try {
    llm = await getLlm();
    const sig = YTC.scoreSignature(llm);
    const details = await fetchDetails(videos.map((v) => v.id));
    const withDetails = videos.filter((v) => details[v.id]).map((v) => Object.assign({}, v, { details: details[v.id] }));
    if (withDetails.length) {
      try {
        const result = await scoreWithRetry(llm, withDetails);
        for (const v of withDetails) final[v.id] = result.scores[v.id] ? Object.assign({}, result.scores[v.id], { x: 1 }) : Object.assign({}, v.first, { x: 0 });
        await recordUsage(llm, result, 0, null);
      } catch (e) {
        for (const v of withDetails) final[v.id].x = 0;
        await recordUsage(llm, null, 0, e.message);
      }
    }
    const keep = {};
    for (const id in final) if (final[id].x) keep[id] = final[id];
    await YTC.cache.setMany(keep, sig);
  } catch (_) {}
  deliver(final);
  inFlight--;
  pump();
}

async function runBatch(videos) {
  inFlight++;
  let llm = null;
  try {
    llm = await getLlm();
    const sig = YTC.scoreSignature(llm);
    for (const v of videos) attempts.set(v.id, (attempts.get(v.id) || 0) + 1);
    const result = await scoreWithRetry(llm, videos);
    const scores = {};
    for (const id in result.scores) scores[id] = Object.assign({}, result.scores[id], { x: 0 });
    await YTC.cache.setMany(scores, sig);
    deliver(scores);
    // The model occasionally skips an entry; give those one more try in a later batch.
    const missing = videos.filter((v) => !result.scores[v.id]);
    const retry = missing.filter((v) => (attempts.get(v.id) || 0) < MAX_ATTEMPTS);
    const giveUp = missing.filter((v) => (attempts.get(v.id) || 0) >= MAX_ATTEMPTS);
    queue.push(...retry);
    if (giveUp.length) fail(giveUp.map((v) => v.id), null);
    await recordUsage(llm, result, videos.length - missing.length, null);
  } catch (e) {
    fail(
      videos.map((v) => v.id),
      e.message
    );
    await recordUsage(llm, null, 0, e.message);
  } finally {
    inFlight--;
    pump();
  }
}

// ---------------- Stats and the hidden log ----------------

// One chain for every write to stats, status and the log, so concurrent updates don't overwrite each other.
let storeLock = Promise.resolve();
function locked(fn) {
  storeLock = storeLock.then(fn).catch(() => {});
  return storeLock;
}

function today() {
  return new Date().toLocaleDateString('en-CA');
}

function freshStats(stats) {
  if (stats && stats.day === today()) return stats;
  return { day: today(), calls: 0, videos: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, cost: 0, hidden: 0, shorts: 0 };
}

function recordUsage(llm, result, scored, error) {
  return locked(async () => {
    const got = await chrome.storage.local.get([STORAGE.stats, STORAGE.status]);
    const stats = freshStats(got[STORAGE.stats]);
    if (result) {
      stats.calls++;
      stats.videos += scored;
      stats.tokensIn += result.usage?.input || 0;
      stats.tokensOut += result.usage?.output || 0;
      stats.tokensCached += result.usage?.cached || 0;
      stats.cost += result.usage?.cost || 0;
    }
    const prev = got[STORAGE.status] || {};
    const status = {
      provider: llm ? llm.provider : prev.provider,
      model: result ? result.model : prev.model || (llm ? llm.models[llm.provider] : ''),
      error: error || null,
      at: Date.now(),
    };
    await chrome.storage.local.set({ [STORAGE.stats]: stats, [STORAGE.status]: status });
  });
}

function recordHidden(video, score, reason) {
  video = cleanVideo(video);
  if (!video || !score) return;
  return locked(async () => {
    const got = await chrome.storage.local.get([STORAGE.stats, STORAGE.log]);
    const stats = freshStats(got[STORAGE.stats]);
    const log = (Array.isArray(got[STORAGE.log]) ? got[STORAGE.log] : []).filter((e) => e.id !== video.id);
    log.unshift({
      id: video.id,
      title: video.title,
      channel: video.channel,
      duration: video.duration,
      v: YTC.clampInt(score.v, 0, 10),
      t: YTC.TOPIC_KEYS.includes(score.t) ? score.t : 'other',
      r: reason === 'topic' ? 'topic' : 'low',
      w: str(score.w, 80),
      x: score.x === 1 ? 1 : 0,
      at: Date.now(),
    });
    stats.hidden++;
    await chrome.storage.local.set({ [STORAGE.stats]: stats, [STORAGE.log]: log.slice(0, LOG_SIZE) });
  });
}

function recordShorts(count) {
  const n = YTC.clampInt(count, 0, 5000);
  if (!n) return;
  return locked(async () => {
    const got = await chrome.storage.local.get(STORAGE.stats);
    const stats = freshStats(got[STORAGE.stats]);
    stats.shorts += n;
    await chrome.storage.local.set({ [STORAGE.stats]: stats });
  });
}

// ---------------- Test connection ----------------

const SAMPLES = [
  { id: 'sample00001', title: 'Lecture 1: The Geometry of Linear Equations', channel: 'University Lectures (demo)', duration: '39:49', views: '4.1M', age: '9 years ago' },
  { id: 'sample00002', title: 'SHE DID WHAT?! 😱 Reacting to the CRAZIEST influencer drama of the week', channel: 'Drama Daily (demo)', duration: '18:02', views: '1.3M', age: '2 days ago' },
  { id: 'sample00003', title: 'Why Nobody Can Explain This Simple Number (It Broke Mathematics)', channel: 'Science Explainers (demo)', duration: '24:11', views: '2.2M', age: '3 weeks ago' },
  { id: 'sample00004', title: 'Midnight City (Official Audio)', channel: 'Synth Band (demo)', duration: '4:03', views: '96M', age: '12 years ago' },
];

async function testConnection(llm) {
  if (!llm.keys[llm.provider]) return { ok: false, error: 'Paste an API key first.' };
  const started = Date.now();
  const result = await YTC.providers.scoreBatch(llm, SAMPLES);
  const ms = Date.now() - started;
  await recordUsage(llm, result, Object.keys(result.scores).length, null);
  return {
    ok: true,
    ms,
    model: result.model,
    usage: result.usage ? { total: (result.usage.input || 0) + (result.usage.output || 0), cost: result.usage.cost || 0 } : null,
    samples: SAMPLES.map((s) => ({ title: s.title, channel: s.channel, score: result.scores[s.id] || null })),
  };
}
