// Run with: node dev/test.js   (run node dev/make-fixtures.js once first)
// Checks the page hook against real YouTube responses, runs the hook inside a simulated page to check the fetch rewrite
// and the early blur, and runs the real background worker in a sandbox with a fake model to check batching, the second
// look and the cache. The content script and panel are checked in dev/mock-youtube.html.
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const hook = require('../src/page/hook.js');
const core = require('../src/shared/core.js');
globalThis.YTC = core;
const prompt = require('../src/background/prompt.js');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e]);
  }
}

function fixture(name) {
  const file = path.join(FIX, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing dev/fixtures/${name}.json; run node dev/make-fixtures.js`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// How many times `key` is used as an object key (YouTube also lists renderer names as plain strings).
const count = (json, key) => JSON.stringify(json).split(`"${key}":`).length - 1;

// A Home grid built from real sidebar lockups, with a Shorts shelf and a Short tile mixed in.
function homeFixture() {
  const watch = fixture('watch');
  const lockups = watch.contents.twoColumnWatchNextResults.secondaryResults.secondaryResults.results[0].itemSectionRenderer.contents
    .filter((x) => x.lockupViewModel && x.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')
    .slice(0, 8);
  const short = { shortsLockupViewModel: { entityId: 'shorts-1', onTap: {} } };
  const contents = lockups.map((l) => ({ richItemRenderer: { content: l } }));
  contents.splice(3, 0, { richSectionRenderer: { content: { richShelfRenderer: { isShorts: true, contents: [{ richItemRenderer: { content: short } }] } } } });
  contents.splice(5, 0, { richItemRenderer: { content: short } });
  contents.push({ continuationItemRenderer: { trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN' } });
  return { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents } } } }] } } };
}

(async () => {
  // ---------------- Hook: Shorts ----------------

  await test('search: every Shorts shelf and chip goes, normal results stay', () => {
    const json = fixture('search');
    const before = hook.collectVideos(json).length;
    assert.ok(count(json, 'shortsLockupViewModel') > 0, 'fixture has Shorts');
    const removed = hook.prune(json, hook.isShorts);
    assert.ok(removed > 0);
    assert.equal(count(json, 'shortsLockupViewModel'), 0);
    assert.equal(count(json, 'reelShelfRenderer'), 0);
    assert.ok(!/"chipViewModel":\{[^{}]*"text":"Shorts"/.test(JSON.stringify(json)), 'Shorts chip removed');
    assert.equal(hook.collectVideos(json).length, before);
  });

  await test('guide: the Shorts entry goes, the rest stays', () => {
    const json = fixture('guide');
    const entries = count(json, 'guideEntryRenderer');
    assert.equal(hook.prune(json, hook.isShorts), 1);
    assert.ok(!JSON.stringify(json).includes('TAB_SHORTS'));
    assert.equal(count(json, 'guideEntryRenderer'), entries - 1);
  });

  await test('channel: the Shorts tab goes', () => {
    const json = fixture('channel');
    hook.prune(json, hook.isShorts);
    assert.ok(!JSON.stringify(json).includes('"url":"/@TED/shorts"'));
    assert.ok(JSON.stringify(json).includes('"url":"/@TED/videos"'));
  });

  await test('home grid: the Shorts shelf and Short tile go, video tiles and the continuation stay', () => {
    const json = homeFixture();
    assert.equal(hook.prune(json, hook.isShorts), 2);
    const contents = json.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents;
    assert.equal(contents.length, 9);
    assert.ok(contents[8].continuationItemRenderer);
  });

  // ---------------- Hook: videos ----------------

  await test('watch sidebar: videos come out with title, channel, length, views and age', () => {
    const videos = hook.collectVideos(fixture('watch'));
    assert.ok(videos.length >= 10, `got ${videos.length}`);
    for (const v of videos) {
      assert.match(v.id, /^[\w-]{11}$/);
      assert.ok(v.title && v.channel, JSON.stringify(v));
    }
    assert.ok(videos.filter((v) => /^\d+(:\d{2}){1,2}$/.test(v.duration)).length >= videos.length * 0.8, 'durations');
    assert.ok(videos.filter((v) => /ago/.test(v.age)).length >= videos.length * 0.8, 'ages');
  });

  await test('search: videos come out of videoRenderer results', () => {
    const videos = hook.collectVideos(fixture('search'));
    assert.ok(videos.length >= 10, `got ${videos.length}`);
    assert.ok(videos.every((v) => v.title && v.channel && /^[\w-]{11}$/.test(v.id)));
  });

  await test('surfaceFor tells Home, its continuations and other feeds apart', () => {
    assert.equal(hook.surfaceFor('browse', { browseId: 'FEwhat_to_watch' }, '/watch'), 'home');
    assert.equal(hook.surfaceFor('browse', { browseId: 'FEsubscriptions' }, '/'), null);
    assert.equal(hook.surfaceFor('browse', { continuation: 'x' }, '/'), 'home');
    assert.equal(hook.surfaceFor('browse', { continuation: 'x' }, '/@someone'), null);
    assert.equal(hook.surfaceFor('next', {}, '/watch'), 'watch');
    assert.equal(hook.surfaceFor('search', {}, '/results'), 'search');
    assert.equal(hook.surfaceFor('guide', {}, '/'), null);
  });

  await test('isFresh tells a first page from a continuation', () => {
    assert.equal(hook.isFresh('browse', { browseId: 'FEwhat_to_watch' }), true);
    assert.equal(hook.isFresh('browse', { continuation: 'x' }), false);
    assert.equal(hook.isFresh('next', { videoId: 'abc' }), true);
    assert.equal(hook.isFresh('next', { continuation: 'x' }), false);
    assert.equal(hook.isFresh('search', { query: 'q' }), true);
    assert.equal(hook.isFresh('search', { continuation: 'x' }), false);
  });

  // ---------------- Hook running in a simulated page ----------------

  function page(opts) {
    const listeners = [];
    const attrs = {};
    const location = { origin: 'https://www.youtube.com', pathname: opts.pathname, replace: (u) => (win.replaced = u) };
    const win = {
      location,
      fetch: opts.fetch,
      addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
      postMessage: (data) => setTimeout(() => listeners.forEach((fn) => fn({ source: win, data }))),
    };
    const sent = [];
    // Stands in for the content script: records what the hook sends.
    listeners.push((e) => e.data.__ytc === 'page' && sent.push(e.data));
    const ctx = {
      window: win,
      location,
      localStorage: { getItem: () => JSON.stringify(opts.config || {}) },
      document: {
        addEventListener() {},
        documentElement: { setAttribute: (k, v) => (attrs[k] = v), removeAttribute: (k) => delete attrs[k] },
      },
      Request,
      Response,
      Headers,
      setTimeout,
      clearTimeout,
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/page/hook.js'), 'utf8'), ctx);
    return { win, sent, attrs };
  }

  const jsonResponse = (obj) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json; charset=UTF-8' } });
  const saved = { surfaces: { home: true, watch: true, search: false }, blur: ['home', 'watch'] };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  await test('hook: the judging blur is on before the first paint, from the saved settings', () => {
    assert.equal(page({ pathname: '/', config: saved }).attrs['data-ytc-blur'], 'home watch');
    assert.equal(page({ pathname: '/', config: { blur: [] } }).attrs['data-ytc-blur'], undefined);
  });

  await test('hook: the panel takes over the menu before the first paint, and lets go when told', async () => {
    assert.equal(page({ pathname: '/', config: { menu: true } }).attrs['data-ytc-menu'], '');
    assert.equal(page({ pathname: '/', config: { menu: false } }).attrs['data-ytc-menu'], undefined);
    assert.equal(page({ pathname: '/', config: {} }).attrs['data-ytc-menu'], '', 'on by default');
    const { win, attrs } = page({ pathname: '/', config: { menu: true } });
    win.postMessage({ __ytc: 'content', kind: 'config', config: { menu: false } });
    await tick();
    assert.equal(attrs['data-ytc-menu'], undefined);
  });

  await test('hook: settings from the content script switch the blur off', async () => {
    const { win, attrs } = page({ pathname: '/', config: saved });
    win.postMessage({ __ytc: 'content', kind: 'config', config: { blur: [] } });
    await tick();
    assert.equal(attrs['data-ytc-blur'], undefined);
  });

  await test('fetch hook: Home response loses its Shorts, keeps every video and sends them for judging', async () => {
    const home = homeFixture();
    const ids = hook.collectVideos(home).map((v) => v.id);
    const { win, sent } = page({ pathname: '/watch', config: saved, fetch: async () => jsonResponse(home) });
    const res = await win.fetch('/youtubei/v1/browse?prettyPrint=false', { method: 'POST', body: JSON.stringify({ browseId: 'FEwhat_to_watch' }) });
    const out = await res.json();
    assert.deepEqual(hook.collectVideos(out).map((v) => v.id), ids);
    assert.equal(count(out, 'shortsLockupViewModel'), 0);
    await tick();
    const ask = sent.find((m) => m.kind === 'videos');
    assert.equal(ask.surface, 'home');
    assert.equal(ask.fresh, true);
    assert.equal(ask.videos.length, ids.length);
    assert.ok(sent.some((m) => m.kind === 'shorts' && m.count === 2));
  });

  await test('fetch hook: a continuation is not a fresh page, and a Request body is read before fetch consumes it', async () => {
    const home = homeFixture();
    const { win, sent } = page({
      pathname: '/',
      config: saved,
      fetch: async (req) => {
        await req.text(); // the real fetch reads the body
        return jsonResponse(home);
      },
    });
    const req = new Request('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', { method: 'POST', body: JSON.stringify({ continuation: 'token' }) });
    await (await win.fetch(req)).json();
    await tick();
    const ask = sent.find((m) => m.kind === 'videos');
    assert.equal(ask.surface, 'home');
    assert.equal(ask.fresh, false);
  });

  await test('fetch hook: a feed that is switched off only loses its Shorts', async () => {
    const search = fixture('search');
    const { win, sent } = page({ pathname: '/results', config: saved, fetch: async () => jsonResponse(search) });
    const out = await (await win.fetch('/youtubei/v1/search?prettyPrint=false', { method: 'POST', body: '{}' })).json();
    assert.equal(count(out, 'shortsLockupViewModel'), 0);
    await tick();
    assert.ok(!sent.some((m) => m.kind === 'videos'));
  });

  await test('fetch hook: a response with no Shorts is handed back as is', async () => {
    const watch = fixture('watch');
    hook.prune(watch, hook.isShorts);
    const original = jsonResponse(watch);
    const { win } = page({ pathname: '/watch', config: saved, fetch: async () => original });
    assert.equal(await win.fetch('/youtubei/v1/next?prettyPrint=false', { method: 'POST', body: '{"videoId":"x"}' }), original);
  });

  await test('fetch hook: other requests pass through untouched', async () => {
    const original = jsonResponse({ hello: 1 });
    const { win } = page({ pathname: '/', config: saved, fetch: async () => original });
    assert.equal(await win.fetch('/youtubei/v1/log_event?alt=json', { method: 'POST', body: '{}' }), original);
  });

  await test('ytInitialData: inline first page loses its Shorts and sends videos for judging', async () => {
    const { win, sent } = page({ pathname: '/', config: saved });
    win.ytInitialData = homeFixture();
    assert.equal(count(win.ytInitialData, 'shortsLockupViewModel'), 0);
    await tick();
    const ask = sent.find((m) => m.kind === 'videos');
    assert.equal(ask.fresh, true);
    assert.equal(ask.videos.length, 8);
  });

  await test('a Shorts URL opens in the normal player', () => {
    const { win } = page({ pathname: '/shorts/abcdefghijk', config: {} });
    assert.equal(win.replaced, '/watch?v=abcdefghijk');
  });

  // ---------------- Core and prompt ----------------

  await test('decide: the IQ bar, music and the allow list', () => {
    const s = Object.assign(core.mergeSettings(null), { minScore: 5, topics: {} });
    const allow = core.mergeAllow(null);
    const v = { id: 'aaaaaaaaaaa', channel: 'Some Channel' };
    assert.equal(core.decide({ v: 4, t: 'science', m: 0 }, s, v, allow).hide, true);
    assert.equal(core.decide({ v: 4, t: 'science', m: 0 }, s, v, allow).reason, 'low');
    assert.equal(core.decide({ v: 5, t: 'science', m: 0 }, s, v, allow).hide, false);
    assert.equal(core.decide({ v: 1, t: 'music', m: 1 }, s, v, allow).hide, false);
    assert.equal(core.decide({ v: 1, t: 'music', m: 1 }, Object.assign({}, s, { allowMusic: false }), v, allow).hide, true);
    assert.equal(core.decide({ v: 1, m: 0 }, s, v, { videos: { aaaaaaaaaaa: 1 }, channels: {} }).hide, false);
    assert.equal(core.decide({ v: 1, m: 0 }, s, v, { videos: {}, channels: { 'Some Channel': 1 } }).hide, false);
    assert.equal(core.decide(undefined, s, v, allow).hide, false);
    assert.equal(core.decide({ v: 0, m: 0 }, Object.assign({}, s, { minScore: 0 }), v, allow).hide, false, 'IQ 70 keeps everything');
  });

  await test('decide: topics marked more get a lower bar, topics marked less always go', () => {
    const s = Object.assign(core.mergeSettings(null), { minScore: 6, topics: { history: 'more', sports: 'less', music: 'less' } });
    const allow = core.mergeAllow(null);
    assert.equal(core.decide({ v: 4, t: 'history', m: 0 }, s, {}, allow).hide, false, 'history bar is 4');
    assert.equal(core.decide({ v: 3, t: 'history', m: 0 }, s, {}, allow).hide, true);
    assert.equal(core.decide({ v: 5, t: 'science', m: 0 }, s, {}, allow).hide, true);
    assert.deepEqual(core.decide({ v: 9, t: 'sports', m: 0 }, s, {}, allow), { hide: true, reason: 'topic' });
    assert.equal(core.decide({ v: 2, t: 'music', m: 1 }, s, {}, allow).reason, 'topic', 'music marked less beats the music exemption');
    assert.equal(core.decide({ v: 9, t: 'sports', m: 0 }, s, { id: 'x' }, { videos: { x: 1 }, channels: {} }).hide, false, 'a shown video stays shown');
    assert.equal(core.iqOf(0), 70);
    assert.equal(core.iqOf(5), 110);
    assert.equal(core.iqOf(10), 150);
  });

  await test('second look: only title-only scores just under the bar', () => {
    const s = Object.assign(core.mergeSettings(null), { minScore: 6, topics: { ai: 'more' } });
    assert.equal(core.wantsSecondLook({ v: 5, t: 'tech', m: 0, x: 0 }, s), true);
    assert.equal(core.wantsSecondLook({ v: 3, t: 'tech', m: 0, x: 0 }, s), true);
    assert.equal(core.wantsSecondLook({ v: 2, t: 'tech', m: 0, x: 0 }, s), false, 'far under the bar');
    assert.equal(core.wantsSecondLook({ v: 6, t: 'tech', m: 0, x: 0 }, s), false, 'already through');
    assert.equal(core.wantsSecondLook({ v: 5, t: 'tech', m: 0, x: 1 }, s), false, 'already looked twice');
    assert.equal(core.wantsSecondLook({ v: 5, t: 'tech', m: 0, x: 2 }, s), false, 'no details to look at');
    assert.equal(core.wantsSecondLook({ v: 3, t: 'music', m: 1, x: 0 }, s), false);
    assert.equal(core.wantsSecondLook({ v: 4, t: 'ai', m: 0, x: 0 }, s), false, 'ai bar is 4');
    assert.equal(core.wantsSecondLook({ v: 1, t: 'ai', m: 0, x: 0 }, s), true);
  });

  await test('settings: v1 strictness gives way to the IQ default, the bar is clamped, topics are cleaned', () => {
    const old = core.mergeSettings({ v: 1, minSignal: 3, surfaces: { search: true } });
    assert.equal(old.minScore, 5);
    assert.equal('minSignal' in old, false);
    assert.deepEqual(old.surfaces, { home: true, watch: true, search: true });
    assert.deepEqual(old.topics, { drama: 'less' });
    assert.equal(old.takeOverMenu, true);
    assert.equal(core.mergeSettings({ v: 2, takeOverMenu: false }).takeOverMenu, false);
    assert.equal(core.mergeSettings({ v: 2, minScore: 14 }).minScore, 10);
    assert.equal(core.mergeSettings({ v: 2, minScore: 7 }).minScore, 7);
    const t = core.mergeSettings({ v: 2, topics: { drama: 'neutral', science: 'more', bogus: 'more', ai: 'lots' } }).topics;
    assert.deepEqual(t, { drama: 'neutral', science: 'more' });
  });

  await test('prompt: lists every topic and parses topics, aliases and depth', () => {
    const [system] = prompt.buildMessages([{ id: 'a', title: 'T', channel: 'C' }]);
    for (const k of core.TOPIC_KEYS) assert.ok(system.content.includes(`${k} = `), k);
    const vids = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = prompt.parseScores('{"r":[{"i":0,"t":"Philosophy","v":8,"b":1,"m":0,"w":"deep"},{"i":1,"t":"science","v":12,"b":0,"m":0,"w":"x"},{"i":2,"t":"weird","v":3,"b":5,"m":0,"w":"y"}]}', vids);
    assert.equal(out.a.t, 'ideas');
    assert.equal(out.b.v, 10);
    assert.equal(out.c.t, 'other');
  });

  await test('prompt: second-look videos carry category, tags, chapters and description', () => {
    const player = fixture('player');
    const details = { description: '0:00 Intro\n1:00 Kant\n2:00 Hume\nA ranked list https://x.y', tags: player.videoDetails.keywords, category: 'Education' };
    const [, user] = prompt.buildMessages([{ id: 'ZK3O402wf1c', title: 'T', channel: 'C', duration: '4:57', views: '1.2M', age: '1d ago', details }]);
    assert.match(user.content, /just under the viewer's level/);
    assert.match(user.content, /category: Education · tags: /);
    assert.match(user.content, /chapters: Intro \| Kant \| Hume/);
    assert.match(user.content, /description: A ranked list \[link\]/);
    assert.match(user.content, /4:57 · 1\.2M views · 1d ago/);
  });

  await test('prompt: replies are parsed by position, truncated replies keep complete entries', () => {
    const vids = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(prompt.parseScores('{"r":[{"i":0,"t":"ai","v":7,"b":2,"m":0,"w":"ok"},{"i":2,"t":"drama","v":1,"b":9,"m":0,"w":"drama"}]}', vids), {
      a: { v: 7, t: 'ai', b: 2, m: 0, w: 'ok' },
      c: { v: 1, t: 'drama', b: 9, m: 0, w: 'drama' },
    });
    const cut = prompt.parseScores('```json\n{"r":[{"i":0,"t":"music","v":2,"b":1,"m":1,"w":"song"},{"i":1,"v":', vids);
    assert.deepEqual(Object.keys(cut), ['a']);
    assert.equal(cut.a.m, 1);
  });

  // ---------------- Background worker in a sandbox ----------------

  function background(opts) {
    const store = { 'ytc:llm': { provider: 'openrouter', keys: { openrouter: 'test-key' } } };
    const listeners = {};
    const tabMessages = [];
    const llmCalls = [];
    const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
    const chrome = {
      storage: {
        local: {
          async get(keys) {
            if (keys == null) return structuredClone(store);
            const out = {};
            for (const k of [].concat(keys)) if (k in store) out[k] = structuredClone(store[k]);
            return out;
          },
          async set(items) {
            Object.assign(store, structuredClone(items));
          },
          async remove(keys) {
            for (const k of [].concat(keys)) delete store[k];
          },
        },
      },
      runtime: { onMessage: on('message'), onInstalled: on('installed'), onStartup: on('startup'), openOptionsPage() {} },
      action: { onClicked: on('action') },
      tabs: {
        async sendMessage(tab, msg) {
          tabMessages.push({ tab, msg });
          if (msg.type === 'details') {
            const details = {};
            for (const id of msg.ids) if (!opts.noDetails?.includes(id)) details[id] = { description: opts.description(id), tags: [], category: 'Education' };
            return { details };
          }
        },
      },
    };
    async function fakeFetch(url, init) {
      const body = JSON.parse(init.body);
      const user = body.messages[1].content;
      llmCalls.push(user);
      const second = /just under the viewer's level/.test(user);
      const r = [...user.matchAll(/^\[(\d+)\] "([^"]+)"/gm)].map(([, i, title]) => Object.assign({ i: +i }, opts.model(title, second)));
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: JSON.stringify({ r }) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    const ctx = { chrome, console, setTimeout, clearTimeout, crypto: globalThis.crypto, structuredClone, fetch: fakeFetch, Response };
    ctx.self = ctx;
    ctx.globalThis = ctx;
    const bgDir = path.join(ROOT, 'src/background');
    ctx.importScripts = (...files) => {
      for (const f of files) vm.runInContext(fs.readFileSync(path.join(bgDir, f), 'utf8'), ctx, { filename: f });
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(bgDir, 'service-worker.js'), 'utf8'), ctx);
    const ask = (type, vs) => new Promise((resolve) => listeners.message({ type, videos: vs }, { tab: { id: 7 } }, resolve));
    const delivered = () => Object.assign({}, ...tabMessages.filter((m) => m.msg.type === 'scores').map((m) => m.msg.scores));
    return { store, listeners, tabMessages, llmCalls, ask, delivered };
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await test('background: first pass scores every video at once with its topic, and caches it', async () => {
    const bg = background({
      description: () => '',
      model: (title) => {
        if (/DRAMA/.test(title)) return { t: 'drama', v: 1, b: 9, m: 0, w: 'drama' };
        if (/Official Audio/.test(title)) return { t: 'music', v: 2, b: 0, m: 1, w: 'song' };
        return { t: 'science', v: 6, b: 1, m: 0, w: 'solid' };
      },
    });
    const videos = [
      { id: 'drama000001', title: 'DRAMA: they did WHAT', channel: 'X' },
      { id: 'song0000001', title: 'Midnight (Official Audio)', channel: 'Z' },
      { id: 'solid000001', title: 'How transistors work', channel: 'W' },
    ];
    const first = await bg.ask('score', videos);
    assert.equal(Object.keys(first.hits).length, 0);
    await wait(500);
    assert.equal(bg.llmCalls.length, 1, 'one batch, no second look on its own');
    const got = bg.delivered();
    assert.deepEqual(Object.keys(got).sort(), ['drama000001', 'solid000001', 'song0000001']);
    assert.equal(got.solid000001.t, 'science');
    assert.equal(got.solid000001.x, 0);
    const again = await bg.ask('score', videos);
    assert.equal(Object.keys(again.hits).length, 3, 'all cached');
    assert.equal(again.hits.drama000001.t, 'drama');
    await wait(400);
    assert.equal(bg.llmCalls.length, 1, 'no new calls');
  });

  await test('background: a recheck judges again with details, caches it, and answers from the cache after that', async () => {
    const bg = background({
      noDetails: ['nodetail001'],
      description: (id) => (id === 'goodbait001' ? 'A careful two-hour lecture.' : 'Reacting to drama.'),
      model: (title, second) => {
        if (/SHOCKING/.test(title)) return { t: 'ideas', v: second ? 7 : 4, b: 8, m: 0, w: second ? 'real lecture' : 'baity title' };
        return { t: 'tech', v: 4, b: 2, m: 0, w: 'light' };
      },
    });
    const videos = [
      { id: 'goodbait001', title: 'SHOCKING truth about Kant', channel: 'Y' },
      { id: 'nodetail001', title: 'Some gadget', channel: 'V' },
      { id: 'notcached01', title: 'Never scored', channel: 'U' },
    ];
    await bg.ask('score', videos.slice(0, 2));
    await wait(500);
    assert.equal(bg.delivered().goodbait001.v, 4);
    const res = await bg.ask('recheck', videos);
    assert.deepEqual([...res.queued].sort(), ['goodbait001', 'nodetail001'], 'a video with no first pass in the cache is not queued');
    await wait(600);
    assert.equal(bg.llmCalls.length, 2);
    assert.match(bg.llmCalls[1], /just under the viewer's level/);
    assert.ok(bg.llmCalls[1].includes('SHOCKING') && !bg.llmCalls[1].includes('Some gadget'), 'only videos with details go to the model');
    const got = bg.delivered();
    assert.equal(got.goodbait001.v, 7);
    assert.equal(got.goodbait001.x, 1);
    assert.equal(got.nodetail001.v, 4);
    assert.equal(got.nodetail001.x, 2, 'no details: the title score stands and is marked so');
    const again = await bg.ask('recheck', videos.slice(0, 2));
    assert.equal(again.hits.goodbait001.v, 7);
    assert.equal(again.hits.nodetail001.x, 2);
    assert.equal(again.queued.length, 0);
    await wait(400);
    assert.equal(bg.llmCalls.length, 2, 'no new calls');

    bg.listeners.message({ type: 'hidden', video: videos[1], score: got.nodetail001, reason: 'low' }, {}, () => {});
    bg.listeners.message({ type: 'shorts', count: 5 }, {}, () => {});
    await wait(50);
    assert.equal(bg.store['ytc:log'][0].id, 'nodetail001');
    assert.equal(bg.store['ytc:log'][0].t, 'tech');
    assert.equal(bg.store['ytc:log'][0].r, 'low');
    assert.equal(bg.store['ytc:log'][0].x, 0, 'x: 2 is not "looked twice"');
    assert.equal(bg.store['ytc:stats'].hidden, 1);
    assert.equal(bg.store['ytc:stats'].shorts, 5);
    assert.equal(bg.store['ytc:stats'].calls, 2);
  });

  let failed = 0;
  for (const [status, name, err] of results) {
    console.log(`${status === 'ok' ? '✓' : '✗'} ${name}`);
    if (err) {
      failed++;
      console.log(`    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    }
  }
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
