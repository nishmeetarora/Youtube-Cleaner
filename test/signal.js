// Runs the extension's own prompt and second look on three sets, with the model in .env:
//   - your 123 labeled Home-feed videos: close calls that the filter should leave alone
//   - a bait sample: top results for slop-heavy searches, which it should mostly catch
//   - test/data/home-now.json, if present: a later Home page, unlabeled, listed with every score
// Usage: node test/signal.js   (writes test/data/signal.json and test/data/signal.md)
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA, loadEnv, readData, writeData, mapLimit, llmConfig, chat, contentOf } = require('./lib');
const core = require('../src/shared/core');
globalThis.YTC = core;
const prompt = require('../src/background/prompt');
const hook = require('../src/page/hook');

const BATCH = 24;
const SECOND_LOOK_BELOW = 5;
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

// First pass on titles, then a second look with details for anything below SECOND_LOOK_BELOW, like the extension.
async function judge(llm, videos, getDetails, usage) {
  const first = await score(llm, videos, usage);
  const doubtful = videos.filter((v) => first[v.id] && !first[v.id].m && first[v.id].v < SECOND_LOOK_BELOW);
  const withDetails = (await mapLimit(doubtful, 4, async (v) => Object.assign({}, v, { details: await getDetails(v) }))).filter((v) => v.details);
  const second = withDetails.length ? await score(llm, withDetails, usage) : {};
  const final = {};
  for (const v of videos) {
    if (!first[v.id]) continue;
    final[v.id] = second[v.id] ? Object.assign({ first: first[v.id].v, x: 1 }, second[v.id]) : Object.assign({ first: first[v.id].v, x: 0 }, first[v.id]);
  }
  return { final, doubtful: doubtful.length, looked: withDetails.length };
}

const hides = (scores, videos, min) =>
  videos.filter((v) => scores[v.id] && core.decide(scores[v.id], Object.assign(core.mergeSettings(null), { minSignal: min }), v, core.mergeAllow(null)).hide);

async function main() {
  loadEnv();
  const llm = llmConfig();
  const labels = readData('labels.json').labels;
  const feed = readData('enriched.json').filter((v) => labels[v.id]);
  const bait = await baitSample();
  console.log(`Judging ${feed.length} feed videos and ${bait.length} bait-sample videos with ${llm.model} via ${llm.id}...`);

  const usage = { input: 0, output: 0 };
  const feedDetails = async (v) => v.api && { description: v.api.description, tags: v.api.tags, category: v.api.category };
  const A = await judge(llm, feed, feedDetails, usage);
  const B = await judge(llm, bait, (v) => details(v.id), usage);
  const nowFile = path.join(DATA, 'home-now.json');
  const now = fs.existsSync(nowFile)
    ? JSON.parse(fs.readFileSync(nowFile, 'utf8')).map(([id, title, channel, duration, views, age]) => ({ id, title, channel, duration, views, age }))
    : [];
  const C = now.length ? await judge(llm, now, (v) => details(v.id), usage) : null;
  writeData('signal.json', { feed: A, bait: B, baitVideos: bait, now: C });

  const md = [];
  md.push(`# Signal filter test`, '', `Model: ${llm.model} via ${llm.id}. ${usage.input} tokens in, ${usage.output} out.`, '');
  md.push(`Second looks: ${A.looked} of ${A.doubtful} doubtful feed videos and ${B.looked} of ${B.doubtful} doubtful bait-sample videos had their description checked.`, '');
  md.push('| Strictness | Hides below | Your feed hidden (should be ~0) | of which you labeled keep | Bait sample hidden (should be high) |');
  md.push('|---|---|---|---|---|');
  for (const s of core.STRICTNESS) {
    const a = hides(A.final, feed, s.min);
    const b = hides(B.final, bait, s.min);
    md.push(`| ${s.label} | ${s.min} | ${a.length} of ${feed.length} | ${a.filter((v) => labels[v.id] === 'keep').length} | ${b.length} of ${bait.length} (${Math.round((b.length / bait.length) * 100)}%) |`);
  }
  const line = (v, sc, extra) => `- v=${sc.v}${sc.x ? ` (title alone: ${sc.first})` : ''} "${v.title}" (${v.channel})${extra ? ` [${extra}]` : ''}: ${sc.w}`;
  for (const s of core.STRICTNESS.filter((s) => s.min >= 3 && s.min <= 4)) {
    md.push('', `## Your feed hidden at "${s.label}" (below ${s.min})`, '');
    const a = hides(A.final, feed, s.min);
    for (const v of a) md.push(line(v, A.final[v.id], `you: ${labels[v.id]}`));
    if (!a.length) md.push('- none');
  }
  const kept = bait.filter((v) => B.final[v.id] && !hides(B.final, [v], 3).length);
  md.push('', `## Bait sample let through at the default (${kept.length})`, '');
  for (const v of kept) md.push(line(v, B.final[v.id], `search: ${v.query}`));
  const rescued = [...feed, ...bait].filter((v) => {
    const sc = A.final[v.id] || B.final[v.id];
    return sc && sc.x && sc.first < 3 && sc.v >= 3;
  });
  md.push('', `## Saved by the second look (title alone scored below 3, description lifted it) (${rescued.length})`, '');
  for (const v of rescued) md.push(line(v, A.final[v.id] || B.final[v.id], labels[v.id] ? `you: ${labels[v.id]}` : `search: ${v.query}`));

  if (C) {
    md.push('', `## Home now (${now.length} videos, unlabeled), lowest first; hidden at the default: ${hides(C.final, now, 3).length}`, '');
    for (const v of now.filter((v) => C.final[v.id]).sort((a, b) => C.final[a.id].v - C.final[b.id].v)) {
      const sc = C.final[v.id];
      md.push(line(v, sc, [sc.m && 'music', hides(C.final, [v], 3).length && 'HIDDEN'].filter(Boolean).join(', ')));
    }
  }

  fs.writeFileSync(path.join(DATA, 'signal.md'), md.join('\n'));
  console.log('\n' + md.join('\n'));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
