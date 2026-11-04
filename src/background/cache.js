// Score cache in chrome.storage.local, one key per video ("sc:<id>").
// Each entry is tagged with a signature of the prompt and model it was scored with; other signatures count as misses.
(function (root) {
  'use strict';

  // A video doesn't change, but YouTube keeps recommending the same ones for weeks.
  const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

  function key(id) {
    return root.YTC.STORAGE.scorePrefix + id;
  }

  async function getMany(ids, sig) {
    if (!ids.length) return {};
    const got = await chrome.storage.local.get(ids.map(key));
    const out = {};
    for (const id of ids) {
      const e = got[key(id)];
      if (e && e.g === sig) out[id] = { v: e.v, t: e.t, b: e.b, m: e.m, w: e.w, x: e.x };
    }
    return out;
  }

  async function setMany(scores, sig) {
    const now = Date.now();
    const items = {};
    for (const id in scores) items[key(id)] = Object.assign({}, scores[id], { g: sig, at: now });
    if (Object.keys(items).length) await chrome.storage.local.set(items);
  }

  async function prune() {
    const all = await chrome.storage.local.get(null);
    const cutoff = Date.now() - MAX_AGE_MS;
    const old = Object.keys(all).filter((k) => k.startsWith(root.YTC.STORAGE.scorePrefix) && !(all[k].at > cutoff));
    if (old.length) await chrome.storage.local.remove(old);
    return old.length;
  }

  async function clear() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(root.YTC.STORAGE.scorePrefix));
    if (keys.length) await chrome.storage.local.remove(keys);
    return keys.length;
  }

  async function count() {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith(root.YTC.STORAGE.scorePrefix)).length;
  }

  root.YTC = Object.assign(root.YTC || {}, { cache: { getMany, setMany, prune, clear, count } });
})(typeof globalThis !== 'undefined' ? globalThis : this);
