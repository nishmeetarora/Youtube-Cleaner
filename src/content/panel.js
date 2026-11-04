// The control panel in YouTube's left menu, under Home. Lives in a shadow root so YouTube's CSS can't touch it.
// Changes apply to the page at once: the IQ slider and the topic chips re-judge every card on screen.
(function (root) {
  'use strict';

  const STOPS = 11; // depth 0-10, shown as IQ 70-150
  const THUMB = 20;

  // Bars, tick labels and the thumb all sit on the same stops: stop i is at half a thumb in from the left, plus
  // i tenths of the width that's left. That's where Chrome draws the thumb of a full-width range input.
  const AT = (i) => `calc(${THUMB / 2}px + ${i} * (100% - ${THUMB}px) / ${STOPS - 1})`;

  const CSS = `
    :host {
      all: initial; display: block; margin: 0 12px; padding: 12px 0 16px; border-bottom: 1px solid var(--line);
      font-family: Roboto, Arial, sans-serif; color: var(--fg); font-size: 14px; line-height: 20px;
      --fg: #0f0f0f; --muted: #606060; --line: rgba(0,0,0,.1); --raised: rgba(0,0,0,.05); --track: rgba(0,0,0,.14);
      --kept: rgba(0,0,0,.3); --accent: #d6002f; --cut: rgba(214,0,47,.55); --ok: #2ba640;
      --more: #065fd4; --more-bg: rgba(6,95,212,.1); --more-line: rgba(6,95,212,.45);
      --less-bg: rgba(214,0,47,.07); --less-line: rgba(214,0,47,.4);
    }
    :host-context(html[dark]) {
      --fg: #f1f1f1; --muted: #aaa; --line: rgba(255,255,255,.2); --raised: rgba(255,255,255,.1); --track: rgba(255,255,255,.2);
      --kept: rgba(255,255,255,.4); --accent: #ff4e6a; --cut: rgba(255,78,106,.6); --ok: #3ec160;
      --more: #3ea6ff; --more-bg: rgba(62,166,255,.14); --more-line: rgba(62,166,255,.5);
      --less-bg: rgba(255,78,106,.1); --less-line: rgba(255,78,106,.45);
    }
    /* When the panel has the whole menu there's nothing below it to separate from. */
    :host-context(html[data-ytc-menu]) { border-bottom: 0; }
    * { box-sizing: border-box; }
    button { font: inherit; color: inherit; }

    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 12px; height: 40px; }
    .title { all: unset; display: flex; align-items: center; gap: 10px; cursor: pointer; font-size: 18px; line-height: 24px; font-weight: 700; user-select: none; }
    .title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
    .logo { width: 24px; height: 24px; flex: none; display: block; }
    .chev { width: 18px; height: 18px; fill: var(--muted); transition: transform .15s; }
    .collapsed .chev { transform: rotate(-90deg); }
    .summary { display: none; padding: 0 12px 0 46px; font-size: 13px; line-height: 18px; color: var(--muted); }
    .collapsed .summary { display: block; }
    .collapsed .body, .collapsed .foot { display: none; }

    .switch { position: relative; width: 40px; height: 22px; flex: none; display: inline-block; }
    .switch input { opacity: 0; width: 0; height: 0; position: absolute; }
    .switch span { position: absolute; inset: 0; border-radius: 999px; background: var(--track); cursor: pointer; transition: background .15s; }
    .switch span::after { content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s; }
    .switch input:checked + span { background: var(--accent); }
    .switch input:checked + span::after { transform: translateX(18px); }
    .switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
    .switch.small { width: 34px; height: 20px; }
    .switch.small span::after { width: 14px; height: 14px; }
    .switch.small input:checked + span::after { transform: translateX(14px); }

    .body { padding: 8px 12px 0; }
    .off :is(.iq, .topics-wrap, .toggle:not(.always)) { opacity: .4; pointer-events: none; }
    .label { font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
    .iq-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 8px; }
    .big { display: block; font-size: 30px; line-height: 36px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
    .count { text-align: right; font-size: 13px; line-height: 18px; color: var(--muted); padding-bottom: 4px; }
    .count b { display: block; font-size: 18px; line-height: 22px; font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; }

    /* IQ of the videos on this page, one bar per slider stop; bars left of the thumb are the ones being hidden. */
    .hist { position: relative; height: 56px; margin-top: 10px; }
    .hist i { position: absolute; bottom: 0; left: calc(${AT('var(--i)')} - (100% - ${THUMB}px) / ${2 * (STOPS - 1)} + 1px);
      width: calc((100% - ${THUMB}px) / ${STOPS - 1} - 2px); height: var(--h); border-radius: 4px 4px 0 0;
      background: var(--kept); cursor: pointer; transition: height .25s; }
    .hist i::before { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 56px; }
    .hist i:hover { filter: brightness(1.15); }
    .hist i.cut { background: var(--cut); }
    .hist i.zero { opacity: .5; }
    .range { position: relative; height: 26px; margin-top: 2px; --t: 5; }
    .range .track, .range .fill { position: absolute; top: 10px; height: 6px; border-radius: 3px; pointer-events: none; }
    .range .track { left: ${THUMB / 2}px; right: ${THUMB / 2}px; background: var(--track); }
    .range .dot { position: absolute; top: 11px; width: 4px; height: 4px; margin-left: -2px; left: ${AT('var(--i)')}; border-radius: 50%;
      background: var(--muted); opacity: .6; pointer-events: none; }
    .range .dot.cut { background: #fff; opacity: .85; }
    .range .fill { left: ${THUMB / 2}px; width: calc(var(--t) * (100% - ${THUMB}px) / ${STOPS - 1}); background: var(--cut); }
    .range input { -webkit-appearance: none; appearance: none; position: absolute; inset: 0; width: 100%; height: 26px; margin: 0;
      background: transparent; outline: none; cursor: pointer; touch-action: none; }
    .range input::-webkit-slider-runnable-track { height: 26px; background: transparent; border: 0; }
    .range input::-webkit-slider-thumb { -webkit-appearance: none; width: ${THUMB}px; height: ${THUMB}px; margin-top: 3px; border-radius: 50%;
      background: #fff; border: 0; box-shadow: 0 0 0 1px rgba(0,0,0,.22), 0 1px 5px rgba(0,0,0,.35); cursor: grab; transition: transform .1s; }
    .range input:active::-webkit-slider-thumb { cursor: grabbing; transform: scale(1.12); }
    .range input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 4px var(--cut), 0 1px 5px rgba(0,0,0,.35); }
    .ticks { position: relative; height: 16px; margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .ticks span { position: absolute; top: 0; left: ${AT('var(--i)')}; transform: translateX(-50%); }
    .ticks span.on { color: var(--accent); font-weight: 700; }
    .ticks span[hidden] { display: none; }
    .hint { font-size: 13px; line-height: 18px; color: var(--muted); margin-top: 8px; min-height: 36px; }

    .topics-wrap { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--line); }
    .section-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
    .section-head small { font-size: 12px; color: var(--muted); }
    .topics { display: flex; flex-wrap: wrap; gap: 7px 6px; }
    .chip { all: unset; font-size: 13px; line-height: 18px; padding: 5px 11px 5px 8px; border-radius: 999px; border: 1px solid var(--line);
      color: var(--fg); cursor: pointer; user-select: none; white-space: nowrap; transition: background-color .1s; }
    .chip .ic { margin-right: 5px; }
    .chip:hover { background: var(--raised); }
    .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .chip[data-pref="more"] { border-color: var(--more-line); background: var(--more-bg); color: var(--more); font-weight: 600; }
    .chip[data-pref="more"] .lbl::after { content: " +"; }
    .chip[data-pref="less"] { border-color: var(--less-line); background: var(--less-bg); color: var(--accent); }
    .chip[data-pref="less"] .lbl { text-decoration: line-through; }
    .chip[data-pref="less"] .ic { filter: grayscale(1); opacity: .6; }

    .disclose { all: unset; display: flex; align-items: center; gap: 6px; color: var(--fg); font-size: 14px; line-height: 20px; font-weight: 500; cursor: pointer; }
    .disclose:hover { color: var(--accent); }
    .disclose:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
    .disclose svg { width: 18px; height: 18px; fill: currentColor; transition: transform .15s; transform: rotate(-90deg); }
    .disclose[aria-expanded="true"] svg { transform: none; }
    .section { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
    .toggles { margin-top: 6px; }
    .toggle { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 38px; font-size: 14px; line-height: 18px; cursor: pointer; }
    .toggle small { display: block; font-size: 12px; line-height: 16px; color: var(--muted); }

    .stats { margin-top: 6px; font-size: 13px; line-height: 18px; color: var(--muted); }
    .stats:empty { display: none; }
    .stats b { color: var(--fg); font-weight: 500; font-variant-numeric: tabular-nums; }
    .list { list-style: none; margin: 8px 0 0; padding: 0; max-height: 420px; overflow-y: auto; }
    .list li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-top: 1px solid var(--line); }
    .list li:first-child { border-top: 0; }
    .score { flex: none; min-width: 34px; height: 22px; padding: 0 5px; border-radius: 6px; background: var(--raised); color: var(--fg); font-weight: 600; font-size: 12px; line-height: 22px; text-align: center; font-variant-numeric: tabular-nums; }
    .info { flex: 1; min-width: 0; }
    .info a { color: var(--fg); text-decoration: none; font-size: 13px; line-height: 18px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .info a:hover { text-decoration: underline; }
    .info div { font-size: 12px; line-height: 16px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
    .show { all: unset; flex: none; font-size: 12px; line-height: 22px; font-weight: 600; color: var(--accent); cursor: pointer; }
    .show:hover { text-decoration: underline; }
    .show:focus-visible { outline: 2px solid var(--accent); border-radius: 4px; }

    .foot { margin-top: 16px; padding: 12px 12px 0; border-top: 1px solid var(--line); font-size: 12px; line-height: 16px; color: var(--muted); }
    .status { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .status span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status .err { color: var(--accent); }
    .status .ok::before { content: "● "; color: var(--ok); }
    .link { all: unset; flex: none; color: var(--fg); font-weight: 600; font-size: 13px; cursor: pointer; }
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
        <div class="iq">
          <div class="iq-head">
            <div><span class="label">Minimum IQ</span><b class="big" id="level"></b></div>
            <div class="count" id="count"></div>
          </div>
          <div class="hist" id="hist"></div>
          <div class="range" id="range">
            <div class="track"></div><div class="fill"></div>
            <input type="range" id="min" min="0" max="${STOPS - 1}" step="1" aria-label="Minimum IQ: hide videos below this">
          </div>
          <div class="ticks" id="ticks" aria-hidden="true"></div>
          <div class="hint" id="hint"></div>
        </div>
        <div class="topics-wrap">
          <div class="section-head"><span class="label">Topics</span><small>tap: more → less → neutral</small></div>
          <div class="topics" id="topics"></div>
        </div>
        <div class="section" id="hiddenSection" hidden>
          <button class="disclose" id="disclose" aria-expanded="false">${CHEVRON}<span id="discloseLabel"></span></button>
          <ul class="list" id="list" hidden></ul>
        </div>
        <div class="section">
          <button class="disclose" id="optionsToggle" aria-expanded="false" aria-controls="options">${CHEVRON}<span>Options</span></button>
          <div class="toggles" id="options" hidden>
            <label class="toggle"><span>Use the whole menu<small>Hides Subscriptions, You and Explore below</small></span><span class="switch small"><input type="checkbox" data-setting="takeOverMenu"><span></span></span></label>
            <label class="toggle"><span>IQ on thumbnails</span><span class="switch small"><input type="checkbox" data-setting="showBadges"><span></span></span></label>
            <label class="toggle"><span>Music always shows</span><span class="switch small"><input type="checkbox" data-setting="allowMusic"><span></span></span></label>
            <label class="toggle"><span>Filter Up next</span><span class="switch small"><input type="checkbox" data-surface="watch"><span></span></span></label>
            <label class="toggle"><span>Filter search</span><span class="switch small"><input type="checkbox" data-surface="search"><span></span></span></label>
            <label class="toggle"><span>Blur until judged</span><span class="switch small"><input type="checkbox" data-setting="blurPending"><span></span></span></label>
            <label class="toggle always"><span>Hide Shorts<small>Takes effect when you reload</small></span><span class="switch small"><input type="checkbox" data-setting="hideShorts"><span></span></span></label>
          </div>
        </div>
        <div class="stats" id="stats"></div>
      </div>
      <div class="foot">
        <div class="status"><span id="status"></span><button class="link" id="settings">Settings</button></div>
      </div>
    </div>
  `;

  const NEXT_PREF = { neutral: 'more', more: 'less', less: 'neutral' };

  function createPanel(ctx) {
    const YTC = root.YTC;
    const iq = YTC.iqOf;
    const host = document.createElement('ytc-panel');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${CSS}</style>${HTML}`;
    const $ = (id) => shadow.getElementById(id);
    const panel = shadow.querySelector('.panel');
    const slider = $('min');
    let listOpen = false;
    let listKey = '';

    // Keep YouTube's keyboard shortcuts (k, j, l, /…) from firing while the panel has focus.
    for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, (e) => e.stopPropagation());

    // The histogram bars and tick labels are built once and only restyled after that.
    const bars = [];
    for (let i = 0; i < STOPS; i++) {
      const bar = document.createElement('i');
      bar.style.setProperty('--i', i);
      bar.addEventListener('click', () => setMin(i));
      bars.push(bar);
    }
    $('hist').append(...bars);
    // A dot on every stop, so it's plain where the thumb can rest.
    const dots = [];
    for (let i = 1; i < STOPS - 1; i++) {
      const d = Object.assign(document.createElement('b'), { className: 'dot' });
      d.style.setProperty('--i', i);
      d.dataset.i = i;
      dots.push(d);
    }
    for (const d of dots) $('range').insertBefore(d, slider);
    // Every other stop is labeled, and the stop the thumb is on always is; its neighbors make room for it.
    const ticks = [];
    for (let i = 0; i < STOPS; i++) {
      const t = Object.assign(document.createElement('span'), { textContent: String(iq(i)) });
      t.style.setProperty('--i', i);
      t.dataset.i = i;
      ticks.push(t);
    }
    $('ticks').append(...ticks);

    const chips = {};
    for (const t of YTC.TOPICS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.innerHTML = '<span class="ic"></span><span class="lbl"></span>';
      b.querySelector('.ic').textContent = t.icon;
      b.querySelector('.lbl').textContent = t.label;
      b.addEventListener('click', () => {
        const s = ctx.getSettings();
        ctx.update({ topics: Object.assign({}, s.topics, { [t.key]: NEXT_PREF[YTC.prefOf(s, t.key)] }) });
      });
      chips[t.key] = b;
      $('topics').appendChild(b);
    }

    function setMin(v) {
      if (v !== ctx.getSettings().minScore) ctx.update({ minScore: v });
    }

    $('enabled').addEventListener('change', (e) => ctx.update({ enabled: e.target.checked }));
    $('collapse').addEventListener('click', () => ctx.update({ panelCollapsed: !ctx.getSettings().panelCollapsed }));
    // The input snaps to whole stops itself; only a real change re-judges the page.
    slider.addEventListener('input', () => {
      ctx.setDragging(true);
      setMin(Number(slider.value));
    });
    slider.addEventListener('change', () => ctx.setDragging(false));
    for (const box of shadow.querySelectorAll('input[data-setting]')) {
      box.addEventListener('change', () => ctx.update({ [box.dataset.setting]: box.checked }));
    }
    for (const box of shadow.querySelectorAll('input[data-surface]')) {
      box.addEventListener('change', () => ctx.update({ surfaces: Object.assign({}, ctx.getSettings().surfaces, { [box.dataset.surface]: box.checked }) }));
    }
    $('optionsToggle').addEventListener('click', () => ctx.update({ optionsOpen: !ctx.getSettings().optionsOpen }));
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

    function levelText(min) {
      return min === 0 ? 'Any' : `${iq(min)}+`;
    }

    function hintText(s) {
      let text = YTC.levelOf(s.minScore).blurb + '.';
      const more = YTC.TOPICS.filter((t) => s.topics[t.key] === 'more');
      if (more.length && s.minScore > 0) {
        const eased = Math.max(0, s.minScore - YTC.MORE_EASE);
        text += ` ${more.length === 1 ? more[0].label : 'Topics marked +'}: IQ ${levelText(eased).replace('Any', 'any')}.`;
      }
      return text;
    }

    function render() {
      const s = ctx.getSettings();
      panel.classList.toggle('off', !s.enabled);
      panel.classList.toggle('collapsed', !!s.panelCollapsed);
      $('collapse').setAttribute('aria-expanded', String(!s.panelCollapsed));
      $('enabled').checked = s.enabled;
      if (Number(slider.value) !== s.minScore) slider.value = String(s.minScore);
      slider.setAttribute('aria-valuetext', `IQ ${levelText(s.minScore)}`);
      $('range').style.setProperty('--t', s.minScore);
      $('level').textContent = levelText(s.minScore);
      $('hint').textContent = hintText(s);
      for (const t of ticks) {
        const i = Number(t.dataset.i);
        const odd = s.minScore % 2 === 1;
        t.classList.toggle('on', i === s.minScore);
        t.hidden = !(i === s.minScore || (i % 2 === 0 && !(odd && Math.abs(i - s.minScore) === 1)));
      }
      for (const d of dots) d.classList.toggle('cut', Number(d.dataset.i) < s.minScore);
      for (const t of YTC.TOPICS) {
        const pref = YTC.prefOf(s, t.key);
        const chip = chips[t.key];
        if (chip.dataset.pref !== pref) chip.dataset.pref = pref;
        chip.title = `${t.label}: ${t.hint}\n${pref === 'more' ? `More: IQ bar ${YTC.MORE_EASE * 8} lower` : pref === 'less' ? 'Less: always hidden' : 'Neutral'}`;
        chip.setAttribute('aria-label', `${t.label}, ${pref}`);
      }
      $('optionsToggle').setAttribute('aria-expanded', String(!!s.optionsOpen));
      $('options').hidden = !s.optionsOpen;
      for (const box of shadow.querySelectorAll('input[data-setting]')) box.checked = !!s[box.dataset.setting];
      for (const box of shadow.querySelectorAll('input[data-surface]')) box.checked = !!s.surfaces[box.dataset.surface];
      renderStats();
    }

    function renderHist(dist, min) {
      const max = Math.max(1, ...dist);
      dist.forEach((c, i) => {
        const bar = bars[i];
        bar.style.setProperty('--h', `${c ? Math.max(4, Math.round((c / max) * 56)) : 2}px`);
        bar.classList.toggle('cut', i < min);
        bar.classList.toggle('zero', !c);
        bar.title = `IQ ${iq(i)}: ${c} video${c === 1 ? '' : 's'} here${i < min ? ', hidden' : ''}. Click to show IQ ${iq(i)} and up.`;
      });
    }

    function hiddenMeta(h) {
      const topic = YTC.topicOf(h.t);
      const why = h.reason === 'topic' ? `${topic.label} is set to less` : h.why;
      return [h.channel, why].filter(Boolean).join(' · ');
    }

    function renderList(st) {
      const list = $('list');
      const n = st.hiddenList.length;
      $('hiddenSection').hidden = !n;
      $('discloseLabel').textContent = `Hidden here (${n})`;
      $('disclose').setAttribute('aria-expanded', String(listOpen && n > 0));
      list.hidden = !(listOpen && n);
      if (list.hidden) {
        listKey = '';
        return;
      }
      const key = st.hiddenList.map((h) => h.id + h.v + h.reason).join();
      if (key === listKey) return;
      listKey = key;
      list.replaceChildren(
        ...st.hiddenList.map((h) => {
          const li = document.createElement('li');
          const score = Object.assign(document.createElement('span'), { className: 'score', textContent: String(iq(h.v)), title: `IQ ${iq(h.v)}` });
          const info = Object.assign(document.createElement('div'), { className: 'info' });
          const a = Object.assign(document.createElement('a'), { href: `/watch?v=${encodeURIComponent(h.id)}`, textContent: h.title || h.id, title: h.title || '' });
          const meta = Object.assign(document.createElement('div'), { textContent: hiddenMeta(h) });
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
      renderHist(st.dist, s.minScore);

      // The count beside the IQ when the page is being filtered; otherwise a line saying why not.
      let text = '';
      const live = s.enabled && st.hasKey && st.surface && st.active && (st.judged || st.pending);
      if (!s.enabled) text = 'Filter is off.';
      else if (!st.hasKey) text = 'Add an API key in Settings to start.';
      else if (!st.surface) text = 'Filters Home, Up next and, if you like, search.';
      else if (!st.active) text = 'Off for this page.';
      else if (!st.judged && !st.pending) text = 'Waiting for videos…';
      else if (st.pending) text = `Judging ${st.pending} more…`;
      $('stats').textContent = text;
      $('count').innerHTML = live ? `<b>${st.hidden} hidden</b>of ${st.judged} judged here` : '';
      $('summary').textContent = s.enabled ? `IQ ${levelText(s.minScore)} · ${st.hidden} hidden here` : 'Filter is off';
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
      }, 150);
    }

    return { el: host, ensure, render, renderStats: scheduleStats };
  }

  root.YTC = Object.assign(root.YTC || {}, { createPanel });
})(typeof globalThis !== 'undefined' ? globalThis : this);
