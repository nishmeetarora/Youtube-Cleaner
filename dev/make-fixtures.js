// Saves real, anonymous YouTube responses to dev/fixtures/ for dev/test.js. No sign-in, nothing personal.
// Usage: node dev/make-fixtures.js
'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'fixtures');
const HEADERS = {
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
};
const CLIENT = { clientName: 'WEB', clientVersion: '2.20251030.01.00', hl: 'en' };

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

async function page(name, url) {
  const res = await fetch(url, { headers: HEADERS });
  const data = pageJson(await res.text(), 'ytInitialData');
  if (!data) throw new Error(`No ytInitialData in ${url}`);
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data));
  console.log(`${name}: ${res.status}`);
}

async function api(name, endpoint, body) {
  const res = await fetch(`https://www.youtube.com/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, HEADERS),
    body: JSON.stringify(Object.assign({ context: { client: CLIENT } }, body)),
  });
  fs.writeFileSync(path.join(OUT, `${name}.json`), await res.text());
  console.log(`${name}: ${res.status}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await page('search', 'https://www.youtube.com/results?search_query=stoicism&hl=en');
  await page('watch', 'https://www.youtube.com/watch?v=ZK3O402wf1c&hl=en');
  await page('channel', 'https://www.youtube.com/@TED?hl=en');
  await api('guide', 'guide', {});
  await api('player', 'player', { videoId: 'ZK3O402wf1c' });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
