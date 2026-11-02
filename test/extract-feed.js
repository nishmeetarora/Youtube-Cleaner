// Runs in the page on youtube.com Home (pasted into the browser). Pulls the videos out of the page's
// feed data and adds them to a sessionStorage list, so several reloads build up one sample.
// Returns { added, total }. Read the full list back with: JSON.parse(sessionStorage.getItem('ytc-test-feed'))
(() => {
  const KEY = 'ytc-test-feed';
  const list = JSON.parse(sessionStorage.getItem(KEY) || '[]');
  const have = new Set(list.map((v) => v.id));
  const text = (t) => (t && (t.content || t.simpleText || (t.runs || []).map((r) => r.text).join(''))) || '';
  let added = 0;

  function add(v) {
    if (!v.id || have.has(v.id)) return;
    have.add(v.id);
    list.push(v);
    added++;
  }

  function fromLockup(lv) {
    const md = lv.metadata?.lockupMetadataViewModel || {};
    const rows = (md.metadata?.contentMetadataViewModel?.metadataRows || []).map((r) => (r.metadataParts || []).map((p) => text(p.text)));
    const raw = JSON.stringify(lv);
    const badge = raw.match(/"text":"((?:\d+:)?\d{1,2}:\d{2})"/);
    const channelId = raw.match(/"browseId":"(UC[\w-]{22})"/);
    const flat = rows.flat();
    add({
      id: lv.contentId,
      title: text(md.title),
      channel: rows[0]?.[0] || '',
      channelId: channelId ? channelId[1] : '',
      duration: badge ? badge[1] : '',
      // Home shows counts like "1.2M" with no "views" label.
      views: flat.find((s) => /view|watching/i.test(s) || /^[\d.,]+\s*[KMB]?$/i.test(s)) || '',
      age: flat.find((s) => /ago|streamed|premiere/i.test(s)) || '',
    });
  }

  function fromVideoRenderer(vr) {
    add({
      id: vr.videoId,
      title: text(vr.title),
      channel: text(vr.ownerText || vr.shortBylineText),
      channelId: vr.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
      duration: text(vr.lengthText),
      views: text(vr.shortViewCountText || vr.viewCountText),
      age: text(vr.publishedTimeText),
    });
  }

  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.shortsLockupViewModel || o.reelItemRenderer || o.adSlotRenderer) return;
    if (o.lockupViewModel) {
      if (o.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') fromLockup(o.lockupViewModel);
      return;
    }
    if (o.videoRenderer) return fromVideoRenderer(o.videoRenderer);
    for (const k in o) walk(o[k]);
  })(window.ytInitialData);

  sessionStorage.setItem(KEY, JSON.stringify(list));
  return { added, total: list.length };
})();
