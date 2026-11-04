(async function () {
  'use strict';
  const YTC = globalThis.YTC;
  const { STORAGE, PROVIDERS } = YTC;
  const $ = (id) => document.getElementById(id);

  const got = await chrome.storage.local.get([STORAGE.llm, STORAGE.settings, STORAGE.allow]);
  let llm = YTC.mergeLlm(got[STORAGE.llm]);
  let settings = YTC.mergeSettings(got[STORAGE.settings]);
  let allow = YTC.mergeAllow(got[STORAGE.allow]);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function el(tag, props, children) {
    const node = Object.assign(document.createElement(tag), props || {});
    for (const c of [].concat(children || [])) node.append(c);
    return node;
  }

  let savedTimer = null;
  function flashSaved() {
    $('savedNote').textContent = 'Saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('savedNote').textContent = ''), 1500);
  }

  let llmTimer = null;
  function saveLlm(delay) {
    clearTimeout(llmTimer);
    llmTimer = setTimeout(async () => {
      await chrome.storage.local.set({ [STORAGE.llm]: llm });
      flashSaved();
    }, delay ?? 400);
  }

  async function saveSettings() {
    await chrome.storage.local.set({ [STORAGE.settings]: settings });
  }

  async function saveAllow() {
    await chrome.storage.local.set({ [STORAGE.allow]: allow });
  }

  // ---- Provider, key, model ----
  for (const [key, p] of Object.entries(PROVIDERS)) {
    const b = el('button', { type: 'button', textContent: p.label });
    b.dataset.value = key;
    b.addEventListener('click', () => {
      llm.provider = key;
      saveLlm(0);
      renderProvider();
    });
    $('providerSeg').appendChild(b);
  }

  function renderProvider() {
    const p = PROVIDERS[llm.provider];
    for (const b of $('providerSeg').children) b.setAttribute('aria-pressed', String(b.dataset.value === llm.provider));
    $('apiKey').value = llm.keys[llm.provider] || '';
    $('model').value = llm.models[llm.provider] || p.defaultModel;
    $('keyLink').href = p.keyUrl;
    $('providerHelp').textContent = p.help || '';
    $('modelHint').textContent = `Default: ${p.defaultModel}`;
    const list = $('modelList');
    list.replaceChildren();
    for (const m of p.models) list.appendChild(el('option', { value: m.id, label: m.note || '' }));
    $('testResult').hidden = true;
  }

  $('apiKey').addEventListener('input', (e) => {
    llm.keys[llm.provider] = e.target.value.trim();
    saveLlm();
  });
  $('model').addEventListener('input', (e) => {
    llm.models[llm.provider] = e.target.value.trim() || PROVIDERS[llm.provider].defaultModel;
    saveLlm(700);
  });
  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('toggleKey').textContent = input.type === 'password' ? 'Show' : 'Hide';
  });

  $('test').addEventListener('click', async () => {
    const btn = $('test');
    const box = $('testResult');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    box.hidden = false;
    box.className = 'test-result';
    box.textContent = 'Judging four sample videos…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'test', llm });
      if (!res || !res.ok) throw new Error(res?.error || 'No response from the extension');
      const rows = res.samples
        .map((s) => {
          const sc = s.score;
          const verdict = !sc ? 'missing' : YTC.decide(sc, settings).hide ? 'would hide' : sc.m ? 'music, kept' : 'kept';
          const nums = sc ? `<b>IQ ${YTC.iqOf(sc.v)}</b> · ${esc(YTC.topicOf(sc.t).label)} · bait ${sc.b}<br>${verdict}` : 'missing';
          return `<tr><td>${esc(s.title)}<div class="help">${esc(s.channel)}${sc?.w ? ` · “${esc(sc.w)}”` : ''}</div></td><td class="num">${nums}</td></tr>`;
        })
        .join('');
      const tokens = res.usage ? ` · ${res.usage.total} tokens` : '';
      const cost = res.usage?.cost ? ` · $${res.usage.cost.toFixed(5)}` : '';
      box.innerHTML = `<div class="head"><span class="ok-mark">✓</span> ${esc(res.model)} answered in ${(res.ms / 1000).toFixed(1)}s${tokens}${cost}</div><table>${rows}</table>`;
    } catch (e) {
      box.className = 'test-result err';
      box.textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test connection';
    }
  });

  // ---- Filter ----
  for (const box of document.querySelectorAll('input[type="checkbox"][data-setting]')) {
    box.addEventListener('change', () => {
      settings[box.dataset.setting] = box.checked;
      saveSettings();
    });
  }
  for (const box of document.querySelectorAll('input[type="checkbox"][data-surface]')) {
    box.addEventListener('change', () => {
      settings.surfaces = Object.assign({}, settings.surfaces, { [box.dataset.surface]: box.checked });
      saveSettings();
    });
  }
  $('minScore').addEventListener('input', (e) => {
    settings.minScore = Number(e.target.value);
    renderIq();
  });
  $('minScore').addEventListener('change', saveSettings);

  function renderIq() {
    const min = settings.minScore;
    $('minScore').value = String(min);
    $('iqLabel').textContent = min === 0 ? 'any' : `${YTC.iqOf(min)} and up`;
    $('iqBlurb').textContent = `${YTC.levelOf(min).blurb}.`;
  }

  // ---- Topics: neutral -> more -> less -> neutral ----
  const NEXT_PREF = { neutral: 'more', more: 'less', less: 'neutral' };
  const chips = {};
  for (const t of YTC.TOPICS) {
    const b = el('button', { type: 'button', className: 'chip' }, [el('span', { className: 'ic', textContent: t.icon }), el('span', { className: 'lbl', textContent: t.label })]);
    b.addEventListener('click', () => {
      settings.topics = Object.assign({}, settings.topics, { [t.key]: NEXT_PREF[YTC.prefOf(settings, t.key)] });
      renderTopics();
      saveSettings();
    });
    chips[t.key] = b;
    $('topics').appendChild(b);
  }

  function renderTopics() {
    for (const t of YTC.TOPICS) {
      const pref = YTC.prefOf(settings, t.key);
      chips[t.key].dataset.pref = pref;
      chips[t.key].title = `${t.hint}\n${pref === 'more' ? 'More: IQ bar 16 lower' : pref === 'less' ? 'Less: always hidden' : 'Neutral'}`;
      chips[t.key].setAttribute('aria-label', `${t.label}, ${pref}`);
    }
  }

  function renderSettings() {
    for (const box of document.querySelectorAll('input[type="checkbox"][data-setting]')) box.checked = !!settings[box.dataset.setting];
    for (const box of document.querySelectorAll('input[type="checkbox"][data-surface]')) box.checked = !!settings.surfaces[box.dataset.surface];
    renderIq();
    renderTopics();
  }

  // ---- Recently hidden ----
  function ago(at) {
    const min = Math.round((Date.now() - at) / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

  async function renderLog() {
    const { [STORAGE.log]: log } = await chrome.storage.local.get(STORAGE.log);
    const list = $('log');
    list.replaceChildren();
    const entries = Array.isArray(log) ? log.slice(0, 100) : [];
    if (!entries.length) list.appendChild(el('li', { className: 'empty', textContent: 'Nothing hidden yet.' }));
    for (const e of entries) {
      const shown = allow.videos[e.id] || (e.channel && allow.channels[e.channel]);
      const why = e.r === 'topic' ? `${YTC.topicOf(e.t).label} is set to less` : e.w && `“${e.w}”`;
      const meta = [e.channel, e.duration, e.t && e.r !== 'topic' ? YTC.topicOf(e.t).label : '', why, e.x ? 'looked twice' : '', ago(e.at)].filter(Boolean).join(' · ');
      const title = el('a', { className: 'title', href: `https://www.youtube.com/watch?v=${encodeURIComponent(e.id)}`, target: '_blank', rel: 'noopener', textContent: e.title });
      const buttons = el('div', { className: 'buttons' });
      if (shown) {
        buttons.append(el('span', { className: 'allowed', textContent: allow.videos[e.id] ? 'Shown' : 'Channel trusted' }));
      } else {
        const show = el('button', { type: 'button', className: 'ghost', textContent: 'Show' });
        show.addEventListener('click', () => {
          allow.videos[e.id] = Date.now();
          saveAllow();
        });
        buttons.append(show);
        if (e.channel) {
          const trust = el('button', { type: 'button', className: 'ghost', textContent: 'Trust channel' });
          trust.addEventListener('click', () => {
            allow.channels[e.channel] = Date.now();
            saveAllow();
          });
          buttons.append(trust);
        }
      }
      list.appendChild(
        el('li', null, [el('div', { className: 'score', textContent: String(YTC.iqOf(e.v)), title: `IQ ${YTC.iqOf(e.v)}` }), el('div', { className: 'body' }, [title, el('div', { className: 'meta', textContent: meta })]), buttons])
      );
    }
    const nv = Object.keys(allow.videos).length;
    const nc = Object.keys(allow.channels).length;
    $('allowNote').textContent = nv || nc ? `${nv} video${nv === 1 ? '' : 's'} shown and ${nc} channel${nc === 1 ? '' : 's'} trusted.` : '';
    $('clearAllow').hidden = !(nv || nc);
  }

  $('clearAllow').addEventListener('click', () => {
    allow = YTC.mergeAllow(null);
    saveAllow();
  });

  // ---- Usage ----
  async function renderUsage() {
    const { [STORAGE.stats]: stats } = await chrome.storage.local.get(STORAGE.stats);
    const today = new Date().toLocaleDateString('en-CA');
    const s = stats && stats.day === today ? stats : {};
    const tokens = (s.tokensIn || 0) + (s.tokensOut || 0);
    const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
    const cells = [
      [(s.videos || 0).toLocaleString(), `videos judged in ${(s.calls || 0).toLocaleString()} calls`],
      [(s.hidden || 0).toLocaleString(), 'videos hidden'],
      [(s.shorts || 0).toLocaleString(), 'Shorts removed'],
      [s.cost ? `$${s.cost.toFixed(4)}` : '—', `${k(tokens)} tokens`],
    ];
    $('usage').replaceChildren(...cells.map(([v, l]) => el('div', null, [el('b', { textContent: v }), el('span', { textContent: l })])));
    const notes = [];
    if (s.videos) notes.push(`${Math.round(tokens / s.videos)} tokens per video`);
    if (s.tokensIn) notes.push(`${Math.round(((s.tokensCached || 0) / s.tokensIn) * 100)}% of input served from the provider's prompt cache`);
    $('usageNote').textContent = notes.join(' · ');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'cacheCount' });
      $('cacheNote').textContent = `${(res?.count || 0).toLocaleString()} videos cached`;
    } catch (_) {}
  }

  $('clearCache').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'clearCache' });
    $('cacheNote').textContent = `Cleared ${(res?.cleared || 0).toLocaleString()} cached scores`;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE.stats]) renderUsage();
    if (changes[STORAGE.settings]) {
      settings = YTC.mergeSettings(changes[STORAGE.settings].newValue);
      renderSettings();
    }
    if (changes[STORAGE.allow]) allow = YTC.mergeAllow(changes[STORAGE.allow].newValue);
    if (changes[STORAGE.log] || changes[STORAGE.allow]) renderLog();
  });

  renderProvider();
  renderSettings();
  renderLog();
  renderUsage();
})();
