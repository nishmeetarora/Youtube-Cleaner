// Runs the extension's own prompt on three sets with the model in .env, and reports what the IQ slider would do:
//   - your 123 labeled Home-feed videos (test/data/labels.json + enriched.json)
//   - test/data/home-now.json, a later Home page, unlabeled
//   - a bait sample: top results for slop-heavy searches, which should land low
//   - anchors: videos from your feed with an ordering you stated (ideas over sports commentary), checked pair by pair
// Every non-music video under IQ 134 also gets the second look (description, tags, chapters), so each slider
// setting can be simulated the way the extension does it: the second-look score counts only for videos whose
// title-only score is just under the bar.
// Usage: node test/iq.js   (writes test/data/iq.json and test/data/iq.md)
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA, loadEnv, readData, writeData, mapLimit, llmConfig, chat, contentOf } = require('./lib');
const core = require('../src/shared/core');
globalThis.YTC = core;
const prompt = require('../src/background/prompt');
const hook = require('../src/page/hook');

const BATCH = 24;

// From a Home feed on 2026-11-04. [id, title, channel, duration, views, age]
const ANCHORS = [
  ['anchorf1raa', 'How Kimi Antonelli destroyed George Russell', 'THE RACE', '12:53', '239K', '18h ago'],
  ['anchorcocai', 'How Cocaine Is Destroying Europe', 'fern', '37:22', '3M', '9mo ago'],
  ['anchorgopro', 'Why Everyone Stopped Buying GoPro', 'ColdFusion', '21:58', '1.1M', '6d ago'],
  ['anchoraibub', "Why Hasn't The AI Bubble Burst (Yet)?", 'MonkeyExplains', '13:57', '1.5M', '2d ago'],
  ['anchorphilo', 'The Biggest Unsolved Problem of Philosophy in 100 Years', "Alex O'Connor", '25:15', '784K', '10mo ago'],
  ['anchortvsfa', 'TVS Fight: Father vs Daughter | From a 1911 Bus Service to a ₹1.8 Lakh Crore Family War', 'Bisbo', '12:47', '571K', '4d ago'],
  ['anchorthiel', 'Peter Thiel is What Marx Warned Us About', 'Acephale', '11:20', '411K', '1mo ago'],
  ['anchorpesso', 'The Terrible Paradox of Self-Awareness | Fernando Pessoa', 'Pursuit of Wonder', '13:03', '6.1M', '3y ago'],
  ['anchorgates', "Bill Gates' Daughter is in Trouble", 'ColdFusion', '17:48', '1.4M', '2w ago'],
  ['anchorswigg', 'Why is Swiggy struggling to make a profit? - Indian Startups News 336', 'Backstage with Millionaires', '11:18', '135K', '2d ago'],
].map(([id, title, channel, duration, views, age]) => ({ id, title, channel, duration, views, age }));
// [higher, lower, by at least]: the ideas videos well above the race debrief, and above the company stories.
const ORDER = [
  ['anchorphilo', 'anchorf1raa', 2],
  ['anchorthiel', 'anchorf1raa', 2],
  ['anchorpesso', 'anchorf1raa', 2],
  ['anchorphilo', 'anchorgopro', 1],
  ['anchorthiel', 'anchorgopro', 1],
  ['anchorpesso', 'anchorgopro', 1],
  ['anchorthiel', 'anchortvsfa', 1],
  ['anchorphilo', 'anchorgates', 1],
];
const LOOK_BELOW = 8;
const BAIT_QUERIES = ['reacting to tiktok drama', 'influencer drama exposed', '24 hour challenge', 'prank gone wrong', 'celebrity gossip news', 'try not to laugh compilation'];
const HEADERS = {
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
};
const CLIENT = { clientName: 'WEB', clientVersion: '2.20251030.01.00', hl: 'en' };

async function innertube(endpoint, body) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, HEADERS),
    body: JSON.stringify(Object.assign({ context: { client: CLIENT } }, body)),
  });
  return res.json();
}

// The same fields the content script fetches for the second look.
async function details(id) {
  const j = await innertube('player', { videoId: id }).catch(() => null);
  const vd = j?.videoDetails;
  if (!vd) return null;
  return { description: vd.shortDescription || '', tags: (vd.keywords || []).slice(0, 15), category: j.microformat?.playerMicroformatRenderer?.category || '' };
}

async function baitSample() {
  const out = new Map();
  for (const q of BAIT_QUERIES) {
    const json = await innertube('search', { query: q });
    hook.prune(json, hook.isShorts);
    for (const v of hook.collectVideos(json).slice(0, 8)) if (!out.has(v.id)) out.set(v.id, Object.assign(v, { query: q }));
  }
  return [...out.values()];
}

async function score(llm, videos, usage) {
  const batches = [];
  for (let i = 0; i < videos.length; i += BATCH) batches.push(videos.slice(i, i + BATCH));
  const parts = await mapLimit(batches, 3, async (batch) => {
    const data = await chat(llm, prompt.buildMessages(batch), 1500 + batch.length * 90);
    usage.input += data.usage?.prompt_tokens || 0;
    usage.output += data.usage?.completion_tokens || 0;
    return prompt.parseScores(contentOf(data), batch);
  });
  return Object.assign({}, ...parts);
}

async function judge(llm, videos, getDetails, usage) {
  const first = await score(llm, videos, usage);
  const doubtful = videos.filter((v) => first[v.id] && !first[v.id].m && first[v.id].v < LOOK_BELOW);
  const withDetails = (await mapLimit(doubtful, 4, async (v) => Object.assign({}, v, { details: await getDetails(v) }))).filter((v) => v.details);
  const second = withDetails.length ? await score(llm, withDetails, usage) : {};
  return { first, second };
}

// The score the extension would end up with at slider setting `min` (topics neutral).
function finalAt(r, id, min) {
  const f = r.first[id];
  if (!f) return null;
  const settings = Object.assign(core.mergeSettings(null), { minScore: min, topics: {} });
  if (core.wantsSecondLook(f, settings) && r.second[id]) return Object.assign({ x: 1 }, r.second[id]);
  return f;
}

function hiddenAt(r, videos, min) {
  const settings = Object.assign(core.mergeSettings(null), { minScore: min, topics: {} });
  return videos.filter((v) => {
    const sc = finalAt(r, v.id, min);
    return sc && core.decide(sc, settings, v, core.mergeAllow(null)).hide;
  });
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const iq = (v) => core.iqOf(v);

function histogram(r, videos) {
  const bins = new Array(11).fill(0);
  for (const v of videos) {
    const sc = r.first[v.id];
    if (sc && !sc.m) bins[sc.v]++;
  }
  return bins;
}

async function main() {
  loadEnv();
  const llm = llmConfig();
  const labels = readData('labels.json').labels;
  const feed = readData('enriched.json').filter((v) => labels[v.id]);
  const now = JSON.parse(fs.readFileSync(path.join(DATA, 'home-now.json'), 'utf8')).map(([id, title, channel, duration, views, age]) => ({ id, title, channel, duration, views, age }));
  const bait = await baitSample();
  console.log(`Judging ${feed.length} labeled, ${now.length} Home-now and ${bait.length} bait videos with ${llm.model} via ${llm.id}...`);

  const usage = { input: 0, output: 0 };
  const feedDetails = async (v) => v.api && { description: v.api.description, tags: v.api.tags, category: v.api.category };
  const A = await judge(llm, feed, feedDetails, usage);
  const C = await judge(llm, now, (v) => details(v.id), usage);
  const B = await judge(llm, bait, (v) => details(v.id), usage);
  const D = { first: await score(llm, ANCHORS, usage), second: {} };
  writeData('iq.json', { feed: A, now: C, bait: B, baitVideos: bait, anchors: D });

  const keeps = feed.filter((v) => labels[v.id] === 'keep');
  const hides = feed.filter((v) => labels[v.id] === 'hide');
  const md = [];
  md.push('# IQ slider test', '', `Model: ${llm.model} via ${llm.id}. ${usage.input} tokens in, ${usage.output} out.`, '');

  md.push('## Anchors from your feed (title only)', '');
  for (const v of [...ANCHORS].sort((a, b) => (D.first[b.id]?.v ?? -1) - (D.first[a.id]?.v ?? -1))) {
    const sc = D.first[v.id];
    md.push(sc ? `- IQ ${iq(sc.v)} ${sc.t} "${v.title}" (${v.channel}): ${sc.w}` : `- missing "${v.title}"`);
  }
  const broken = ORDER.filter(([hi, lo, gap]) => !(D.first[hi] && D.first[lo] && D.first[hi].v - D.first[lo].v >= gap));
  const name = (id) => ANCHORS.find((v) => v.id === id).title.slice(0, 40);
  md.push('', `Ordering checks: ${ORDER.length - broken.length} of ${ORDER.length} hold.`);
  for (const [hi, lo, gap] of broken) md.push(`- broken: "${name(hi)}" should be at least ${gap * 8} IQ above "${name(lo)}"`);
  md.push('');

  md.push('## Title-only IQ distribution (music left out)', '');
  md.push(`| Set | ${core.LEVELS.map((l) => iq(l.min)).join(' | ')} |`);
  md.push(`|---|${core.LEVELS.map(() => '---').join('|')}|`);
  for (const [name, r, vids] of [
    ['Labeled: you kept', A, keeps],
    ['Labeled: you hid', A, hides],
    ['Home now', C, now],
    ['Bait sample', B, bait],
  ]) {
    md.push(`| ${name} | ${histogram(r, vids).join(' | ')} |`);
  }

  md.push('', '## Hidden at each slider setting (topics neutral, music shown, second look as in the extension)', '');
  md.push('| Min IQ | Labeled kept hidden | Labeled hid hidden | Home now hidden | Bait hidden |');
  md.push('|---|---|---|---|---|');
  for (let min = 2; min <= 8; min++) {
    const a = hiddenAt(A, keeps, min).length;
    const h = hiddenAt(A, hides, min).length;
    const c = hiddenAt(C, now, min).length;
    const b = hiddenAt(B, bait, min).length;
    md.push(`| ${iq(min)} | ${a} of ${keeps.length} (${pct(a, keeps.length)}) | ${h} of ${hides.length} (${pct(h, hides.length)}) | ${c} of ${now.length} (${pct(c, now.length)}) | ${b} of ${bait.length} (${pct(b, bait.length)}) |`);
  }

  md.push('', '## Topics', '');
  md.push('| Topic | Labeled kept | Labeled hid | Home now |');
  md.push('|---|---|---|---|');
  for (const t of core.TOPICS) {
    const n = (r, vids) => vids.filter((v) => r.first[v.id]?.t === t.key).length;
    const row = [n(A, keeps), n(A, hides), n(C, now)];
    if (row.some(Boolean)) md.push(`| ${t.label} | ${row.join(' | ')} |`);
  }

  const line = (v, sc, extra) =>
    `- IQ ${iq(sc.v)}${sc.x ? ` (title alone ${iq(sc.first)})` : ''} ${sc.t} "${v.title}" (${v.channel}, ${v.duration || '?'})${extra ? ` [${extra}]` : ''}: ${sc.w}`;
  const withFirst = (r, id, min) => {
    const f = finalAt(r, id, min);
    return f && Object.assign({}, f, { first: r.first[id].v });
  };

  md.push('', '## Labeled feed, highest first (final score at IQ 110)', '');
  for (const v of feed.filter((v) => A.first[v.id]).sort((a, b) => withFirst(A, b.id, 5).v - withFirst(A, a.id, 5).v)) {
    const sc = withFirst(A, v.id, 5);
    md.push(line(v, sc, [labels[v.id], sc.m && 'music'].filter(Boolean).join(', ')));
  }

  md.push('', '## Home now, highest first (final score at IQ 110)', '');
  for (const v of now.filter((v) => C.first[v.id]).sort((a, b) => withFirst(C, b.id, 5).v - withFirst(C, a.id, 5).v)) {
    const sc = withFirst(C, v.id, 5);
    md.push(line(v, sc, sc.m ? 'music' : ''));
  }

  md.push('', '## Bait sample above IQ 86 at IQ 110', '');
  for (const v of bait.filter((v) => B.first[v.id] && withFirst(B, v.id, 5).v >= 3)) md.push(line(v, withFirst(B, v.id, 5), `search: ${v.query}`));

  fs.writeFileSync(path.join(DATA, 'iq.md'), md.join('\n'));
  console.log('\n' + md.slice(0, 40).join('\n'));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
