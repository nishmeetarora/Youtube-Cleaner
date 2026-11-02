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

  await test('decide: threshold, music and the allow list', () => {
    const s = core.mergeSettings(null);
    const allow = core.mergeAllow(null);
    const v = { id: 'aaaaaaaaaaa', channel: 'Some Channel' };
    assert.equal(core.decide({ v: 2, m: 0 }, s, v, allow).hide, true);
    assert.equal(core.decide({ v: 3, m: 0 }, s, v, allow).hide, false);
    assert.equal(core.decide({ v: 1, m: 1 }, s, v, allow).hide, false);
    assert.equal(core.decide({ v: 1, m: 1 }, Object.assign({}, s, { allowMusic: false }), v, allow).hide, true);
    assert.equal(core.decide({ v: 1, m: 0 }, s, v, { videos: { aaaaaaaaaaa: 1 }, channels: {} }).hide, false);
    assert.equal(core.decide({ v: 1, m: 0 }, s, v, { videos: {}, channels: { 'Some Channel': 1 } }).hide, false);
    assert.equal(core.decide(undefined, s, v, allow).hide, false);
  });

  await test('settings: strictness is clamped and surfaces merge', () => {
    assert.equal(core.mergeSettings({ minSignal: 9 }).minSignal, 5);
    assert.deepEqual(core.mergeSettings({ surfaces: { search: true } }).surfaces, { home: true, watch: true, search: true });
  });

  await test('prompt: second-look videos carry category, tags, chapters and description', () => {
    const player = fixture('player');
    const details = { description: '0:00 Intro\n1:00 Kant\n2:00 Hume\nA ranked list https://x.y', tags: player.videoDetails.keywords, category: 'Education' };
    const [, user] = prompt.buildMessages([{ id: 'ZK3O402wf1c', title: 'T', channel: 'C', duration: '4:57', views: '1.2M', age: '1d ago', details }]);
    assert.match(user.content, /looked doubtful/);
    assert.match(user.content, /category: Education · tags: /);
    assert.match(user.content, /chapters: Intro \| Kant \| Hume/);
    assert.match(user.content, /description: A ranked list \[link\]/);
    assert.match(user.content, /4:57 · 1\.2M views · 1d ago/);
  });

  await test('prompt: replies are parsed by position, truncated replies keep complete entries', () => {
    const vids = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(prompt.parseScores('{"r":[{"i":0,"v":7,"b":2,"m":0,"w":"ok"},{"i":2,"v":1,"b":9,"m":0,"w":"drama"}]}', vids), {
      a: { v: 7, b: 2, m: 0, w: 'ok' },
      c: { v: 1, b: 9, m: 0, w: 'drama' },
    });
    const cut = prompt.parseScores('```json\n{"r":[{"i":0,"v":5,"b":1,"m":1,"w":"song"},{"i":1,"v":', vids);
    assert.deepEqual(Object.keys(cut), ['a']);
    assert.equal(cut.a.m, 1);
  });

  // ---------------- Background worker in a sandbox ----------------

  await test('background: batches, gives low scorers a second look with details, caches', async () => {
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
            for (const id of msg.ids) details[id] = { description: id === 'goodbait001' ? 'A careful two-hour lecture.' : 'Reacting to drama.', tags: [], category: 'Education' };
            return { details };
          }
        },
      },
    };
    // Fake model: drama is slop either way; the baity good video scores low on its title and high with its description.
    async function fakeFetch(url, init) {
      const body = JSON.parse(init.body);
      const user = body.messages[1].content;
      llmCalls.push(user);
      const second = /looked doubtful/.test(user);
      const r = [...user.matchAll(/^\[(\d+)\] "([^"]+)"/gm)].map(([, i, title]) => {
        if (/DRAMA/.test(title)) return { i: +i, v: 1, b: 9, m: 0, w: 'drama' };
        if (/SHOCKING/.test(title)) return { i: +i, v: second ? 7 : 2, b: 8, m: 0, w: second ? 'real lecture' : 'baity title' };
        if (/Official Audio/.test(title)) return { i: +i, v: 0, b: 0, m: 1, w: 'song' };
        return { i: +i, v: 6, b: 1, m: 0, w: 'solid' };
      });
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

    const videos = [
      { id: 'drama000001', title: 'DRAMA: they did WHAT', channel: 'X' },
      { id: 'goodbait001', title: 'SHOCKING truth about Kant', channel: 'Y' },
      { id: 'song0000001', title: 'Midnight (Official Audio)', channel: 'Z' },
      { id: 'solid000001', title: 'How transistors work', channel: 'W' },
    ];
    const ask = (vs) => new Promise((resolve) => listeners.message({ type: 'score', videos: vs }, { tab: { id: 7 } }, resolve));
    const first = await ask(videos);
    assert.equal(Object.keys(first.hits).length, 0);
    await new Promise((r) => setTimeout(r, 600));

    assert.equal(llmCalls.length, 2, 'one first pass, one second look');
    assert.match(llmCalls[1], /looked doubtful/);
    assert.ok(llmCalls[1].includes('DRAMA') && llmCalls[1].includes('SHOCKING') && !llmCalls[1].includes('Official Audio'));
    assert.deepEqual([...tabMessages.find((m) => m.msg.type === 'details').msg.ids].sort(), ['drama000001', 'goodbait001']);

    const delivered = Object.assign({}, ...tabMessages.filter((m) => m.msg.type === 'scores').map((m) => m.msg.scores));
    assert.equal(delivered.goodbait001.v, 7);
    assert.equal(delivered.goodbait001.x, 1);
    assert.equal(delivered.drama000001.v, 1);
    assert.equal(delivered.song0000001.m, 1);
    assert.equal(delivered.solid000001.v, 6);
    const s = core.mergeSettings(null);
    const hidden = Object.keys(delivered).filter((id) => core.decide(delivered[id], s, { id }, core.mergeAllow(null)).hide);
    assert.deepEqual(hidden, ['drama000001']);

    const again = await ask(videos);
    assert.equal(Object.keys(again.hits).length, 4, 'all cached');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(llmCalls.length, 2, 'no new calls');

    listeners.message({ type: 'hidden', video: videos[0], score: delivered.drama000001 }, {}, () => {});
    listeners.message({ type: 'shorts', count: 5 }, {}, () => {});
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(store['ytc:log'][0].id, 'drama000001');
    assert.equal(store['ytc:stats'].hidden, 1);
    assert.equal(store['ytc:stats'].shorts, 5);
    assert.equal(store['ytc:stats'].calls, 2);
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
