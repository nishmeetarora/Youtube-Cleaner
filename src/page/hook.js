// Runs in the page's own JS world at document_start, before YouTube's scripts.
// Drops Shorts from YouTube's data everywhere before it renders, and sends the videos in each feed to the content
// script for judging. It also turns on the "judging" blur for the filtered feeds before the first paint, from settings
// the content script mirrors into localStorage, so no card shows unjudged even for a moment.
(function (root) {
  'use strict';

  const text = (t) => (t && (t.content || t.simpleText || (t.runs || []).map((r) => r.text).join(''))) || '';

  // ---------------- Shorts ----------------

  // As object keys, not as names in YouTube's lists of supported renderers.
  const SHORTS_KEYS = /"(?:shortsLockupViewModel|reelItemRenderer|reelShelfRenderer|reelWatchEndpoint)":\{/;

  function isShorts(el) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return false;
    if (el.reelShelfRenderer || el.shortsLockupViewModel || el.reelItemRenderer) return true;
    if (el.richItemRenderer) {
      const c = el.richItemRenderer.content || {};
      return !!(c.shortsLockupViewModel || c.reelItemRenderer);
    }
    if (el.richSectionRenderer || el.gridShelfViewModel || el.shelfRenderer) {
      if (el.richSectionRenderer?.content?.richShelfRenderer?.isShorts) return true;
      return SHORTS_KEYS.test(JSON.stringify(el));
    }
    const vr = el.videoRenderer || el.compactVideoRenderer || el.gridVideoRenderer;
    if (vr) return !!vr.navigationEndpoint?.reelWatchEndpoint;
    if (el.lockupViewModel) return /"reelWatchEndpoint":\{/.test(JSON.stringify(el.lockupViewModel.rendererContext || {}));
    const guide = el.guideEntryRenderer || el.miniGuideEntryRenderer;
    if (guide) {
      return /^TAB_SHORTS/.test(guide.icon?.iconType || '') || !!(guide.navigationEndpoint?.reelWatchEndpoint || guide.serviceEndpoint?.reelWatchEndpoint);
    }
    if (el.tabRenderer) return /\/shorts$/.test(el.tabRenderer.endpoint?.commandMetadata?.webCommandMetadata?.url || '');
    if (el.chipViewModel) return el.chipViewModel.text === 'Shorts';
    if (el.chipCloudChipRenderer) return text(el.chipCloudChipRenderer.text) === 'Shorts';
    return false;
  }

  // Removes matching elements from every array in the tree, in place. Returns how many were removed.
  function prune(node, test) {
    let removed = 0;
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 80) return;
      if (Array.isArray(o)) {
        for (let i = o.length - 1; i >= 0; i--) {
          if (test(o[i])) {
            o.splice(i, 1);
            removed++;
          } else {
            walk(o[i], depth + 1);
          }
        }
        return;
      }
      for (const k in o) walk(o[k], depth + 1);
    })(node, 0);
    return removed;
  }

  // ---------------- Videos ----------------

  function fromLockup(lv) {
    const md = lv.metadata?.lockupMetadataViewModel || {};
    const rows = (md.metadata?.contentMetadataViewModel?.metadataRows || []).map((r) => (r.metadataParts || []).map((p) => text(p.text)));
    const flat = rows.flat();
    const thumb = JSON.stringify(lv.contentImage || {});
    const badge = thumb.match(/"text":"((?:\d+:)?\d{1,2}:\d{2})"/);
    return {
      id: lv.contentId,
      title: text(md.title),
      channel: rows[0]?.[0] || '',
      duration: badge ? badge[1] : /"text":"LIVE"/.test(thumb) ? 'live' : '',
      // Home shows counts like "1.2M" with no "views" label.
      views: flat.find((s) => /view|watching/i.test(s) || /^[\d.,]+\s*[KMB]?$/i.test(s)) || '',
      age: flat.find((s) => /ago|streamed|premiere/i.test(s)) || '',
    };
  }

  function fromRenderer(vr) {
    return {
      id: vr.videoId,
      title: text(vr.title),
      channel: text(vr.ownerText || vr.shortBylineText || vr.longBylineText),
      duration: text(vr.lengthText),
      views: text(vr.shortViewCountText || vr.viewCountText),
      age: text(vr.publishedTimeText),
    };
  }

  // The video a list element stands for: a grid tile, a search result or a sidebar entry. Null for anything else.
  function itemContent(el) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return null;
    return el.richItemRenderer ? el.richItemRenderer.content || null : el;
  }

  function itemVideoId(el) {
    const c = itemContent(el);
    if (!c) return null;
    if (c.lockupViewModel) return c.lockupViewModel.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? c.lockupViewModel.contentId || null : null;
    const vr = c.videoRenderer || c.compactVideoRenderer || c.gridVideoRenderer;
    return (vr && vr.videoId) || null;
  }

  function itemVideo(el) {
    if (!itemVideoId(el)) return null;
    const c = itemContent(el);
    return c.lockupViewModel ? fromLockup(c.lockupViewModel) : fromRenderer(c.videoRenderer || c.compactVideoRenderer || c.gridVideoRenderer);
  }

  function collectVideos(json) {
    const out = new Map();
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 80) return;
      if (Array.isArray(o)) {
        for (const el of o) {
          const v = itemVideo(el);
          if (v) {
            if (v.title && !out.has(v.id)) out.set(v.id, v);
          } else {
            walk(el, depth + 1);
          }
        }
        return;
      }
      for (const k in o) walk(o[k], depth + 1);
    })(json, 0);
    return [...out.values()];
  }

  // Which feed a response belongs to. The first Home page asks for browseId FEwhat_to_watch; its continuations carry
  // only a token, and they load on the page being scrolled.
  function surfaceFor(endpoint, body, pathname) {
    if (endpoint === 'next') return 'watch';
    if (endpoint === 'search') return 'search';
    if (endpoint === 'browse') {
      if (body && body.browseId) return body.browseId === 'FEwhat_to_watch' ? 'home' : null;
      return pathname === '/' ? 'home' : null;
    }
    return null;
  }

  function surfaceOfPath(pathname) {
    if (pathname === '/' || pathname === '/feed/recommended') return 'home';
    if (pathname === '/watch') return 'watch';
    if (pathname === '/results') return 'search';
    return null;
  }

  const api = { isShorts, prune, collectVideos, itemVideoId, surfaceFor, isFresh };
  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    return;
  }

  // A feed's first page, as opposed to a continuation of the one on screen.
  function isFresh(endpoint, body) {
    if (!body) return false;
    if (endpoint === 'browse') return !!body.browseId;
    if (endpoint === 'next') return !!body.videoId;
    if (endpoint === 'search') return !body.continuation;
    return false;
  }

  // ---------------- In the page ----------------

  if (window.__ytcHooked) return;
  window.__ytcHooked = true;

  const ORIGIN = location.origin;
  // The content script mirrors its settings here so they are readable before it has loaded.
  const CONFIG_KEY = 'ytc-config';
  let config = { enabled: true, hideShorts: true, surfaces: { home: true, watch: true, search: false }, blur: [] };
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    if (saved && typeof saved === 'object') config = Object.assign(config, saved);
  } catch (_) {}

  // Feeds whose cards stay blurred until judged; content.css keys off this attribute.
  function applyBlur() {
    const blur = Array.isArray(config.blur) ? config.blur.join(' ') : '';
    if (blur) document.documentElement?.setAttribute('data-ytc-blur', blur);
    else document.documentElement?.removeAttribute('data-ytc-blur');
  }
  applyBlur();

  function post(msg) {
    window.postMessage(Object.assign({ __ytc: 'page' }, msg), ORIGIN);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__ytc !== 'content') return;
    if (e.data.kind === 'config' && e.data.config && typeof e.data.config === 'object') {
      config = Object.assign({}, config, e.data.config);
      applyBlur();
    }
  });

  function clientVersion() {
    try {
      return window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '';
    } catch (_) {
      return '';
    }
  }

  function dropShorts(json) {
    if (!config.hideShorts) return false;
    const n = prune(json, isShorts);
    if (n) post({ kind: 'shorts', count: n });
    return n > 0;
  }

  // Sends a feed's videos for judging. The content script hides the ones that don't make it once they render.
  function sendVideos(json, surface, fresh) {
    if (!surface || !config.enabled || !config.surfaces?.[surface]) return;
    const videos = collectVideos(json);
    if (videos.length || fresh) post({ kind: 'videos', surface, fresh, videos, client: clientVersion() });
  }

  // ---- fetch: feed pages, continuations, search, the watch sidebar and the guide all come through here ----
  const ENDPOINT = /\/youtubei\/v1\/(browse|next|search|guide)(?:\?|$)/;
  const origFetch = window.fetch;

  async function readBody(input, init) {
    try {
      if (init && typeof init.body === 'string') return init.body;
      if (input instanceof Request) return await input.clone().text();
    } catch (_) {}
    return null;
  }

  async function rewrite(res, endpoint, bodyText) {
    try {
      if (!res.ok || !/json/.test(res.headers.get('content-type') || '')) return res;
      let body = null;
      try {
        body = JSON.parse((await bodyText) || 'null');
      } catch (_) {}
      const json = await res.clone().json();
      const dropped = dropShorts(json);
      sendVideos(json, surfaceFor(endpoint, body, location.pathname), isFresh(endpoint, body));
      if (!dropped) return res;
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      const out = new Response(JSON.stringify(json), { status: res.status, statusText: res.statusText, headers });
      Object.defineProperty(out, 'url', { value: res.url });
      return out;
    } catch (_) {
      return res;
    }
  }

  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      let endpoint = null;
      try {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
        const m = url.match(ENDPOINT);
        endpoint = m ? m[1] : null;
      } catch (_) {}
      if (!endpoint) return origFetch.apply(this, arguments);
      // Read the request body before fetch consumes it.
      const bodyText = readBody(input, init);
      return origFetch.apply(this, arguments).then((res) => rewrite(res, endpoint, bodyText));
    };
  }

  // ---- The first page of a full load arrives inline as `var ytInitialData = {...}` ----
  let initialData;
  try {
    Object.defineProperty(window, 'ytInitialData', {
      configurable: true,
      enumerable: true,
      get() {
        return initialData;
      },
      set(value) {
        try {
          if (value && typeof value === 'object') {
            dropShorts(value);
            sendVideos(value, surfaceOfPath(location.pathname), true);
          }
        } catch (_) {}
        initialData = value;
      },
    });
  } catch (_) {}

  // ---- A Shorts link opens the normal player instead ----
  function leaveShorts() {
    if (!config.hideShorts) return;
    const m = location.pathname.match(/^\/shorts\/([\w-]{11})/);
    if (m) location.replace(`/watch?v=${m[1]}`);
  }
  leaveShorts();
  document.addEventListener('yt-navigate-finish', leaveShorts);
  window.addEventListener('popstate', leaveShorts);
})(typeof globalThis !== 'undefined' ? globalThis : this);
