// The control panel in YouTube's left menu, under Home. Lives in a shadow root so YouTube's CSS can't touch it.
// Changes apply to the page at once: the strictness slider re-judges every card on screen as it moves.
(function (root) {
  'use strict';

  const BINS = 6; // signal 0, 1, 2, 3, 4 and 5+; the slider sits on the boundaries between them

  const CSS = `
    :host {
      all: initial; display: block; margin: 0 12px; padding: 10px 0 12px; border-bottom: 1px solid var(--line);
      font-family: Roboto, Arial, sans-serif; color: var(--fg);
      --fg: #0f0f0f; --muted: #606060; --line: rgba(0,0,0,.1); --raised: rgba(0,0,0,.05); --track: rgba(0,0,0,.14);
      --kept: rgba(0,0,0,.26); --accent: #d6002f; --cut: rgba(214,0,47,.62); --ok: #2ba640;
    }
    :host-context(html[dark]) {
      --fg: #f1f1f1; --muted: #aaa; --line: rgba(255,255,255,.2); --raised: rgba(255,255,255,.1); --track: rgba(255,255,255,.2);
      --kept: rgba(255,255,255,.32); --accent: #ff4e6a; --cut: rgba(255,78,106,.7); --ok: #3ec160;
    }
    * { box-sizing: border-box; }
    button { font: inherit; color: inherit; }

    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 12px; height: 36px; }
    .title { all: unset; display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 16px; line-height: 22px; font-weight: 600; user-select: none; }
    .title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
    .logo { width: 22px; height: 22px; flex: none; display: block; }
    .chev { width: 16px; height: 16px; fill: var(--muted); transition: transform .15s; }
    .collapsed .chev { transform: rotate(-90deg); }
    .summary { display: none; padding: 0 12px 0 44px; font-size: 12px; line-height: 16px; color: var(--muted); }
    .collapsed .summary { display: block; }
    .collapsed .body, .collapsed .foot { display: none; }

    .switch { position: relative; width: 36px; height: 20px; flex: none; display: inline-block; }
    .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--track); cursor: pointer; transition: background .15s; }
    .switch span::after { content: ""; position: absolute; left: 3px; top: 3px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s; }
    .switch input:checked + span { background: var(--accent); }
    .switch input:checked + span::after { transform: translateX(16px); }
    .switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
    .switch.small { width: 30px; height: 18px; }
    .switch.small span::after { width: 12px; height: 12px; }
    .switch.small input:checked + span::after { transform: translateX(12px); }

    .body { padding: 6px 12px 0; }
    .off .body > :not(.always) { opacity: .4; pointer-events: none; }
    .row-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 14px; line-height: 20px; }
    .row-head b { font-weight: 500; color: var(--accent); }

    /* Scores of the videos on this page; bins left of the thumb are the ones being hidden. */
    .hist { position: relative; height: 34px; margin-top: 8px; }
    .hist i { position: absolute; bottom: 0; left: calc(var(--i) * 100% / ${BINS} + 2px); width: calc(100% / ${BINS} - 4px); height: var(--h);
      border-radius: 3px 3px 0 0; background: var(--kept); transition: height .25s, background-color .15s; }
    .hist i.cut { background: var(--cut); }
    .hist i.zero { height: 2px; opacity: .6; }
    .range { position: relative; height: 20px; --t: 3; }
    .range .track, .range .fill { position: absolute; top: 8px; height: 4px; border-radius: 2px; pointer-events: none; }
    .range .track { left: 0; right: 0; background: var(--track); }
    .range .fill { left: 0; width: calc(var(--t) * 100% / ${BINS}); background: var(--cut); }
    /* The input spans from the boundary after bin 0 to the one after bin 4, so its thumb lands on bin edges. */
    .range input { -webkit-appearance: none; appearance: none; position: absolute; top: 0; height: 20px; margin: 0;
      left: calc(100% / ${BINS} - 8px); width: calc(100% * 4 / ${BINS} + 16px); background: transparent; outline: none; cursor: pointer; }
    .range input::-webkit-slider-runnable-track { height: 20px; background: transparent; border: 0; }
    .range input::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; margin-top: 2px; border-radius: 50%;
      background: #fff; border: 0; box-shadow: 0 0 0 1px rgba(0,0,0,.2), 0 1px 4px rgba(0,0,0,.35); cursor: grab; transition: transform .1s; }
    .range input:active::-webkit-slider-thumb { cursor: grabbing; transform: scale(1.15); }
    .range input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px var(--cut), 0 1px 4px rgba(0,0,0,.35); }
    .ticks { display: grid; grid-template-columns: repeat(${BINS}, 1fr); font-size: 10px; line-height: 12px; color: var(--muted); text-align: center; margin-top: 1px; }
    .hint { font-size: 12px; line-height: 16px; color: var(--muted); margin-top: 6px; }

    .toggles { margin-top: 10px; }
    .toggle { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; font-size: 13px; line-height: 16px; cursor: pointer; }
    .toggle small { display: block; font-size: 11px; line-height: 14px; color: var(--muted); }

    .foot { margin-top: 8px; padding: 8px 12px 0; border-top: 1px solid var(--line); font-size: 12px; line-height: 16px; color: var(--muted); }
    .stats b { color: var(--fg); font-weight: 500; font-variant-numeric: tabular-nums; }
    .disclose { all: unset; display: flex; align-items: center; gap: 4px; margin-top: 6px; color: var(--fg); font-size: 12px; font-weight: 500; cursor: pointer; }
    .disclose:hover { color: var(--accent); }
    .disclose:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    .disclose svg { width: 14px; height: 14px; fill: currentColor; transition: transform .15s; transform: rotate(-90deg); }
    .disclose[aria-expanded="true"] svg { transform: none; }
    .list { list-style: none; margin: 6px 0 0; padding: 0; max-height: 280px; overflow-y: auto; }
    .list li { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-top: 1px solid var(--line); }
    .list li:first-child { border-top: 0; }
    .score { flex: none; width: 20px; height: 20px; border-radius: 6px; background: var(--raised); color: var(--fg); font-weight: 500; font-size: 11px; line-height: 20px; text-align: center; font-variant-numeric: tabular-nums; }
    .info { flex: 1; min-width: 0; }
    .info a { color: var(--fg); text-decoration: none; font-size: 12px; line-height: 16px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .info a:hover { text-decoration: underline; }
    .info div { font-size: 11px; line-height: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .show { all: unset; flex: none; font-size: 11px; font-weight: 500; color: var(--accent); cursor: pointer; padding: 2px 0; }
    .show:hover { text-decoration: underline; }
    .show:focus-visible { outline: 2px solid var(--accent); border-radius: 4px; }
    .status { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; }
    .status span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status .err { color: var(--accent); }
    .status .ok::before { content: "● "; color: var(--ok); }
    .link { all: unset; flex: none; color: var(--fg); font-weight: 500; cursor: pointer; }
    .link:hover { color: var(--accent); }
    .link:focus-visible { outline: 2px solid var(--accent); border-radius: 4px; }
  `;

  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>';
  const LOGO =
    '<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#d6002f"/>' +
    '<path d="M5.2 6.2h13.6l-5.2 6.4v5.4l-3.2 1.6v-7z" fill="#fff"/></svg>';

  const HTML = `
    <div class="panel">
      <div class="head">
        <button class="title" id="collapse" aria-expanded="true" title="Collapse or expand">${LOGO}<span>Cleaner</span><svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg></button>
        <label class="switch" title="Filter on or off"><input type="checkbox" id="enabled" aria-label="Filter my feed"><span></span></label>
      </div>
      <div class="summary" id="summary"></div>
      <div class="body">
        <div class="row-head"><span>Strictness</span><b id="level"></b></div>
        <div class="hist" id="hist" aria-hidden="true"></div>
        <div class="range" id="range">
          <div class="track"></div><div class="fill"></div>
          <input type="range" id="min" min="1" max="5" step="1" aria-label="Strictness: hide videos scoring below this">
        </div>
        <div class="ticks" aria-hidden="true"><span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5+</span></div>
        <div class="hint" id="hint"></div>
        <div class="toggles">
          <label class="toggle"><span>Music always shows</span><span class="switch small"><input type="checkbox" data-setting="allowMusic"><span></span></span></label>
          <label class="toggle"><span>Filter Up next</span><span class="switch small"><input type="checkbox" data-surface="watch"><span></span></span></label>
          <label class="toggle"><span>Filter search</span><span class="switch small"><input type="checkbox" data-surface="search"><span></span></span></label>
          <label class="toggle"><span>Blur until judged</span><span class="switch small"><input type="checkbox" data-setting="blurPending"><span></span></span></label>
          <label class="toggle always"><span>Hide Shorts<small>Takes effect when you reload</small></span><span class="switch small"><input type="checkbox" data-setting="hideShorts"><span></span></span></label>
        </div>
      </div>
      <div class="foot">
        <div class="stats" id="stats"></div>
        <button class="disclose" id="disclose" aria-expanded="false" hidden>${CHEVRON}<span id="discloseLabel"></span></button>
        <ul class="list" id="list" hidden></ul>
        <div class="status"><span id="status"></span><button class="link" id="settings">Settings</button></div>
      </div>
    </div>
  `;

  function createPanel(ctx) {
    const YTC = root.YTC;
    const host = document.createElement('ytc-panel');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>${HTML}`;
    const $ = (id) => shadow.getElementById(id);
    const panel = shadow.querySelector('.panel');
    let listOpen = false;

    // Keep YouTube's keyboard shortcuts (k, j, l, /…) from firing while the panel has focus.
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());

    $('enabled').addEventListener('change', (e) => ctx.update({ enabled: e.target.checked }));
    $('collapse').addEventListener('click', () => ctx.update({ panelCollapsed: !ctx.getSettings().panelCollapsed }));
    $('min').addEventListener('input', (e) => ctx.update({ minSignal: Number(e.target.value) }));
    for (const box of shadow.querySelectorAll('input[data-setting]')) {
      box.addEventListener('change', () => ctx.update({ [box.dataset.setting]: box.checked }));
    }
    for (const box of shadow.querySelectorAll('input[data-surface]')) {
      box.addEventListener('change', () => ctx.update({ surfaces: Object.assign({}, ctx.getSettings().surfaces, { [box.dataset.surface]: box.checked }) }));
    }
    $('disclose').addEventListener('click', () => {
      listOpen = !listOpen;
      renderStats();
    });
    $('settings').addEventListener('click', () => ctx.openSettings());

    // Under Home, at the top of the menu. YouTube re-renders the menu now and then, so this runs on every DOM pass.
    function ensure() {
      const sections = document.querySelector('ytd-guide-renderer #sections');
      const first = sections && sections.querySelector(':scope > ytd-guide-section-renderer');
      if (!first) return;
      if (host.parentElement !== sections || host.previousElementSibling !== first) first.after(host);
    }

    function render() {
      const s = ctx.getSettings();
      const level = YTC.strictnessOf(s.minSignal);
      panel.classList.toggle('off', !s.enabled);
      panel.classList.toggle('collapsed', !!s.panelCollapsed);
      $('collapse').setAttribute('aria-expanded', String(!s.panelCollapsed));
      $('enabled').checked = s.enabled;
      // Don't fight the thumb mid-drag.
      if (shadow.activeElement !== $('min')) $('min').value = String(s.minSignal);
      $('range').style.setProperty('--t', s.minSignal);
      $('level').textContent = level.short;
      $('hint').textContent = level.blurb.replace(/ \(recommended\)$/, '');
      for (const box of shadow.querySelectorAll('input[data-setting]')) box.checked = !!s[box.dataset.setting];
      for (const box of shadow.querySelectorAll('input[data-surface]')) box.checked = !!s.surfaces[box.dataset.surface];
      renderStats();
    }

    function renderHist(dist, t) {
      const max = Math.max(1, ...dist);
      const hist = $('hist');
      hist.replaceChildren(
        ...dist.map((c, i) => {
          const bar = document.createElement('i');
          bar.style.setProperty('--i', i);
          bar.style.setProperty('--h', `${c ? Math.max(3, Math.round((c / max) * 34)) : 2}px`);
          bar.className = [i < t ? 'cut' : '', c ? '' : 'zero'].join(' ').trim();
          bar.title = `Signal ${i === BINS - 1 ? '5 or more' : i}: ${c} video${c === 1 ? '' : 's'}${i < t ? ', hidden' : ''}`;
          return bar;
        })
      );
    }

    function renderList(st) {
      const list = $('list');
      const n = st.hiddenList.length;
      $('disclose').hidden = !n;
      $('discloseLabel').textContent = `Hidden here (${n})`;
      $('disclose').setAttribute('aria-expanded', String(listOpen && n > 0));
      list.hidden = !(listOpen && n);
      if (list.hidden) return;
      list.replaceChildren(
        ...st.hiddenList.map((h) => {
          const li = document.createElement('li');
          const score = Object.assign(document.createElement('span'), { className: 'score', textContent: String(h.v), title: `Signal ${h.v} of 10` });
          const info = Object.assign(document.createElement('div'), { className: 'info' });
          const a = Object.assign(document.createElement('a'), { href: `/watch?v=${encodeURIComponent(h.id)}`, textContent: h.title || h.id, title: h.title || '' });
          const meta = Object.assign(document.createElement('div'), { textContent: [h.channel, h.why].filter(Boolean).join(' · ') });
          meta.title = meta.textContent;
          info.append(a, meta);
          const show = Object.assign(document.createElement('button'), { className: 'show', textContent: 'Show', title: 'Always show this video' });
          show.addEventListener('click', () => ctx.allowVideo(h.id));
          li.append(score, info, show);
          return li;
        })
      );
    }

    function renderStats() {
      const s = ctx.getSettings();
      const st = ctx.getPageStats();
      const status = ctx.getStatus();
      renderHist(st.dist, s.minSignal);

      let text;
      if (!s.enabled) text = 'Filter is off.';
      else if (!st.hasKey) text = 'Add an API key in Settings to start.';
      else if (!st.surface) text = 'Filters Home, Up next and, if you like, search.';
      else if (!st.active) text = 'Off for this page.';
      else if (!st.judged && !st.pending) text = 'Waiting for videos…';
      else {
        text = `<b>${st.judged}</b> judged · <b>${st.hidden}</b> hidden`;
        if (st.pending) text += ` · ${st.pending} judging…`;
      }
      $('stats').innerHTML = text;
      $('summary').textContent = s.enabled ? `${YTC.strictnessOf(s.minSignal).short} · ${st.hidden} hidden here` : 'Filter is off';
      renderList(st);

      const el = $('status');
      const err = st.error || status.error;
      if (err && err !== 'no_key') {
        el.className = 'err';
        el.textContent = String(err);
      } else if (status.model) {
        el.className = 'ok';
        el.textContent = String(status.model).replace(/^[\w-]+\//, '') + (status.cost ? ` · $${status.cost.toFixed(3)} today` : '');
      } else {
        el.className = '';
        el.textContent = '';
      }
      el.title = el.textContent;
    }

    let statsTimer = null;
    function scheduleStats() {
      if (statsTimer) return;
      statsTimer = setTimeout(() => {
        statsTimer = null;
        renderStats();
      }, 200);
    }

    return { el: host, ensure, render, renderStats: scheduleStats };
  }

  root.YTC = Object.assign(root.YTC || {}, { createPanel });
})(typeof globalThis !== 'undefined' ? globalThis : this);
