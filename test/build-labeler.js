// Prepares the labeling page's data: the video list and a thumbnail per video, in test/data/labeler/.
// Usage: node test/build-labeler.js   (reads test/data/feed.json)
'use strict';

const fs = require('fs');
const path = require('path');
const { DATA, readData, mapLimit } = require('./lib');

async function main() {
  const feed = readData('feed.json');
  const out = path.join(DATA, 'labeler');
  fs.mkdirSync(path.join(out, 'thumbs'), { recursive: true });
  fs.writeFileSync(
    path.join(out, 'videos.json'),
    JSON.stringify(feed.map(({ id, title, channel, duration, views, age }) => ({ id, title, channel, duration, views, age })))
  );
  const missing = [];
  await mapLimit(feed, 6, async (v) => {
    const file = path.join(out, 'thumbs', `${v.id}.jpg`);
    if (fs.existsSync(file)) return;
    const res = await fetch(`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`);
    if (!res.ok) return missing.push(v.id);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  });
  console.log(`Wrote ${feed.length} videos to test/data/labeler/` + (missing.length ? ` (${missing.length} thumbnails missing)` : ''));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
