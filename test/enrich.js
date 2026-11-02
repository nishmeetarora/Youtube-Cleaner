// Adds video details, channel profiles and DeArrow community titles to the feed sample. Details come from
// the YouTube Data API when YOUTUBE_API_KEY is set, otherwise from the public watch and channel pages.
// Usage: node test/enrich.js   (reads test/data/feed.json, writes test/data/enriched.json)
'use strict';

const { loadEnv, readData, writeData, sleep, mapLimit } = require('./lib');

const CATEGORIES = {
  1: 'Film & Animation', 2: 'Autos & Vehicles', 10: 'Music', 15: 'Pets & Animals', 17: 'Sports', 19: 'Travel & Events',
  20: 'Gaming', 22: 'People & Blogs', 23: 'Comedy', 24: 'Entertainment', 25: 'News & Politics', 26: 'Howto & Style',
  27: 'Education', 28: 'Science & Technology', 29: 'Nonprofits & Activism',
};

// The key goes in a header, not the URL.
async function youtube(resource, params) {
  const url = `https://www.googleapis.com/youtube/v3/${resource}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'X-Goog-Api-Key': process.env.YOUTUBE_API_KEY } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Data API ${resource} ${res.status}: ${body.error?.message || ''}`);
  return body.items || [];
}

async function inChunks(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) out.push(...(await fn(ids.slice(i, i + 50))));
  return out;
}

// "https://en.wikipedia.org/wiki/Video_game_culture" -> "Video game culture"
const topicNames = (urls) => (urls || []).map((u) => decodeURIComponent(u.split('/').pop()).replace(/_/g, ' '));

const BROWSER_HEADERS = {
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
};

async function youtubePage(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: BROWSER_HEADERS }).catch(() => null);
    if (res?.ok) return res.text();
    await sleep(1000 * (attempt + 1));
  }
  return null;
}

// Pulls the object assigned to `name = {...}` out of a YouTube page's HTML.
function pageJson(html, name) {
  const at = html.indexOf(`${name} = {`);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

// "23.8M" -> 23800000, "1,694" -> 1694
function parseCount(text) {
  const m = String(text || '').replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
  return m ? Math.round(parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1)) : null;
}

// The Data API's video fields, read from the watch page instead. There are no topic categories here.
async function videoFromPage(id) {
  const html = await youtubePage(`https://www.youtube.com/watch?v=${id}&hl=en`);
  const player = html && pageJson(html, 'ytInitialPlayerResponse');
  const vd = player?.videoDetails;
  if (!vd) return null;
  const data = JSON.stringify(pageJson(html, 'ytInitialData') || {});
  const likes = data.match(/like this video along with ([\d,]+)/);
  const comments = data.match(/"contextualInfo":\{"runs":\[\{"text":"([^"]+)"/);
  return {
    channelId: vd.channelId,
    description: vd.shortDescription || '',
    tags: vd.keywords || [],
    category: player.microformat?.playerMicroformatRenderer?.category || '',
    language: '',
    topics: [],
    captions: !!player.captions,
    views: Number(vd.viewCount || 0),
    likes: likes ? parseCount(likes[1]) : null,
    comments: comments ? parseCount(comments[1]) : null,
  };
}

async function channelFromPage(channelId) {
  const html = await youtubePage(`https://www.youtube.com/channel/${channelId}?hl=en`);
  const data = html && pageJson(html, 'ytInitialData');
  if (!data) return null;
  const header = JSON.stringify(data.header || {});
  const subscribers = header.match(/"([\d.,]+[KMB]?) subscribers"/);
  const videos = header.match(/"([\d,]+) videos?"/);
  const meta = data.metadata?.channelMetadataRenderer || {};
  return {
    description: meta.description || '',
    country: '',
    subscribers: subscribers ? parseCount(subscribers[1]) : null,
    videoCount: videos ? parseCount(videos[1]) : null,
    topics: [],
  };
}

async function detailsFromApi(ids) {
  const videos = await inChunks(ids, (chunk) =>
    youtube('videos', {
      part: 'snippet,contentDetails,statistics,topicDetails',
      id: chunk.join(','),
      fields: 'items(id,snippet(channelId,description,tags,categoryId,defaultAudioLanguage),contentDetails(duration,caption),statistics(viewCount,likeCount,commentCount),topicDetails(topicCategories))',
    })
  );
  const channelIds = [...new Set(videos.map((v) => v.snippet.channelId))];
  const channels = await inChunks(channelIds, (chunk) =>
    youtube('channels', {
      part: 'snippet,statistics,topicDetails',
      id: chunk.join(','),
      fields: 'items(id,snippet(title,description,country),statistics(subscriberCount,videoCount,hiddenSubscriberCount),topicDetails(topicCategories))',
    })
  );
  const byVideo = new Map(videos.map((api) => [api.id, {
    channelId: api.snippet.channelId,
    description: api.snippet.description || '',
    tags: api.snippet.tags || [],
    category: CATEGORIES[api.snippet.categoryId] || api.snippet.categoryId,
    language: api.snippet.defaultAudioLanguage || '',
    topics: topicNames(api.topicDetails?.topicCategories),
    captions: api.contentDetails.caption === 'true',
    views: Number(api.statistics.viewCount || 0),
    likes: api.statistics.likeCount == null ? null : Number(api.statistics.likeCount),
    comments: api.statistics.commentCount == null ? null : Number(api.statistics.commentCount),
  }]));
  const byChannel = new Map(channels.map((ch) => [ch.id, {
    description: ch.snippet.description || '',
    country: ch.snippet.country || '',
    subscribers: ch.statistics.hiddenSubscriberCount ? null : Number(ch.statistics.subscriberCount || 0),
    videoCount: Number(ch.statistics.videoCount || 0),
    topics: topicNames(ch.topicDetails?.topicCategories),
  }]));
  return { byVideo, byChannel };
}

async function detailsFromPages(ids) {
  const videos = await mapLimit(ids, 4, async (id) => {
    const v = await videoFromPage(id);
    await sleep(250);
    return v;
  });
  const byVideo = new Map(ids.map((id, i) => [id, videos[i]]).filter(([, v]) => v));
  const channelIds = [...new Set([...byVideo.values()].map((v) => v.channelId))];
  const channels = await mapLimit(channelIds, 4, async (id) => {
    const c = await channelFromPage(id);
    await sleep(250);
    return c;
  });
  const byChannel = new Map(channelIds.map((id, i) => [id, channels[i]]).filter(([, c]) => c));
  return { byVideo, byChannel };
}

// Best community title, or null when there is none or voters kept the original.
async function dearrow(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://sponsor.ajay.app/api/branding?videoID=${id}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(String(res.status));
      const best = ((await res.json()).titles || []).find((t) => t.locked || t.votes >= 0);
      return best && !best.original ? best.title.replace(/(^|\s)>(\S)/g, '$1$2') : null;
    } catch (_) {
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

async function main() {
  loadEnv();
  const feed = readData('feed.json');
  const ids = feed.map((v) => v.id);
  const source = process.env.YOUTUBE_API_KEY ? 'Data API' : 'watch pages';
  const { byVideo, byChannel } = source === 'Data API' ? await detailsFromApi(ids) : await detailsFromPages(ids);

  const titles = await mapLimit(ids, 4, async (id) => {
    const t = await dearrow(id);
    await sleep(150);
    return t;
  });

  const enriched = feed.map((v, i) => {
    const api = byVideo.get(v.id);
    return { ...v, api, channelInfo: api && byChannel.get(api.channelId), dearrow: titles[i] };
  });

  writeData('enriched.json', enriched);
  const n = enriched.length;
  console.log(`Enriched ${n} videos: ${enriched.filter((v) => v.api).length} with details (from ${source}), ` +
    `${enriched.filter((v) => v.channelInfo).length} with channel profiles, ${enriched.filter((v) => v.dearrow).length} with a DeArrow title.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
