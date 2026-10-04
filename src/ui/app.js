const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const P = window.pipeline;
let S = { dir: null }, busy = false, bust = Date.now();
const SET = ['maxClips', 'maxSec', 'pngPct', 'clipImageRatio', 'maxStockRow', 'transition'];
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(window.__t); window.__t = setTimeout(() => t.classList.remove('show'), 3200); };
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return String(m).padStart(2, '0') + ':' + r.toFixed(1).padStart(4, '0'); };

// Every IPC answer is {ok,state} or {ok:false,error}.
async function call(fn, ...a) {
  const r = await fn(...a);
  if (!r.ok) { if (!r.cancelled) toast(r.error); setStatus(r.error, 0); render(); return null; }
  S = r.state; bust = Date.now(); render(); return S;
}
function setStatus(msg, pct) { $('#status').textContent = msg; if (pct != null) $('#bar').style.width = Math.round(pct * 100) + '%'; }
function setBusy(b) {
  busy = b; $('#cancelBtn').hidden = !b;
  $$('[data-step],#runAll,#newProj,#openProj,#audioPick,#facePick,#overlayPick,#saveSettings,#ovAllOn,#ovAllOff,#exportBtn').forEach((e) => { e.disabled = b; if (e.classList.contains('pick')) e.style.pointerEvents = b ? 'none' : ''; });
  $$('.item .btn,.item .ov input').forEach((e) => (e.disabled = b));
}
P.onProgress((p) => setStatus(p.msg, p.pct));

function render() {
  $('#projPath').textContent = S.dir || '';
  const has = !!S.dir, pr = S.project || {};
  $('#audioName').textContent = pr.audioName || 'Choose audio file';
  $('#faceName').textContent = pr.faceName || 'Choose face photo';
  $('#overlayName').textContent = pr.overlayName || 'Choose overlay clip';
  const fi = $('#faceImg'); if (pr.face && S.dir) { fi.src = P.fileUrl(S.dir, pr.face) + '?v=' + bust; fi.hidden = false; } else fi.hidden = true;
  if (S.settings) { for (const k of SET) if (document.activeElement !== $('#' + k)) $('#' + k).value = S.settings[k]; if (document.activeElement !== $('#searchOrder')) $('#searchOrder').value = S.settings.searchOrder || 'pexels'; }
  $('#runAll').disabled = !has || busy; $('#exportBtn').disabled = !has || busy; $('#showFinal').hidden = !S.finalVideo;
  const t = S.transcript, m = S.moments, pl = S.plan;
  $('#summary').innerHTML = [
    t ? `<span class="pill ok">transcript.json · ${Math.round(t.duration)} s · ${t.words} words</span>` : '<span class="pill">no transcript</span>',
    m ? `<span class="pill ok">moments.json · ${m.moments.length} avatar</span>` : '<span class="pill">no moments</span>',
    pl ? `<span class="pill ok">plan.json · ${pl.items.length} B-roll items</span>` : '<span class="pill">no plan</span>',
  ].join('');
  renderPlan();
}

function renderPlan() {
  const list = $('#list'), cnt = $('#counts'), pl = S.plan, m = S.moments;
  if (!m && !pl) { cnt.innerHTML = ''; list.innerHTML = '<div class="empty">Nothing yet. Choose the audio and the face photo, then press Run all steps.</div>'; return; }
  const rows = [];
  for (const a of (m ? m.moments : [])) rows.push({ t: 'av', ...a });
  for (const b of (pl ? pl.items : [])) rows.push({ t: 'br', ...b });
  rows.sort((x, y) => x.start - y.start);
  const c = pl ? pl.counts : { png: 0, clip: 0, image: 0, total: 0 };
  const reasons = {}; for (const b of (pl ? pl.items : [])) if (b.fallbackReason) { const r = b.fallbackReason.split(':')[0]; reasons[r] = (reasons[r] || 0) + 1; }
  const note = (pl && pl.adjusted ? `<span class="pill" title="Too many stock items for the 'max in a row' rule, so ${pl.adjusted} became PNG">${pl.adjusted} stock → PNG (row rule)</span>` : '') +
    Object.entries(reasons).map(([r, n]) => `<span class="pill" title="No good stock file was found, so a PNG slide was made">${n} stock → PNG (${esc(r)})</span>`).join('');
  cnt.innerHTML = `<span class="pill">Avatar moments <b>${m ? m.moments.length : 0}</b></span><span class="pill">PNG slides <b>${c.png}</b></span><span class="pill">Stock clips <b>${c.clip}</b></span><span class="pill">Stock images <b>${c.image}</b></span><span class="pill">B-roll total <b>${c.total}</b></span>${note}`;
  list.innerHTML = rows.map((r) => {
    const len = (r.end - r.start).toFixed(1) + ' s';
    const time = `<div class="time"><b>${fmt(r.start)} – ${fmt(r.end)}</b>${len}<br>${esc(r.id)}</div>`;
    if (r.t === 'av') {
      const face = S.project.face ? `<img src="${P.fileUrl(S.dir, S.project.face)}?v=${bust}" alt="">` : 'no face photo';
      return `<div class="item">${time}<div class="thumb face">${face}</div><div><div class="kind av">${r.type === 'intro' ? 'Avatar · intro' : 'Avatar moment'}</div><p class="txt">${esc(r.title || '')}</p><div class="small">Face photo is used until an avatar clip exists (Part C).</div></div></div>`;
    }
    const ovOn = !!r.overlay, ovBox = `<label class="ov" title="${S.project.overlay ? 'Show the overlay clip on this item' : 'Choose the overlay clip first'}"><input type="checkbox" data-ov ${ovOn ? 'checked' : ''}> Overlay</label>`;
    const btns = `<div class="btns"><button class="btn" data-act="regenerate">Regenerate</button><button class="btn" data-act="replace">Replace</button><button class="btn" data-act="remove">Delete</button>${ovBox}</div>`;
    const fb = r.fallbackReason ? `<div class="small">Was stock. Now PNG: ${esc(r.fallbackReason)}.</div>` : '';
    if (r.kind === 'png') {
      const ok = r.slide, img = ok ? `<img src="${P.fileUrl(S.dir, r.slide)}?v=${bust}" alt="">` : `<span class="err">${r.error ? esc(r.error) : 'slide not made yet'}</span>`;
      return `<div class="item" data-id="${r.id}">${time}<div class="thumb ${ok ? '' : 'err'}">${img}</div><div><div class="kind png">PNG slide${r.style ? ' · ' + esc(r.style) : ''}${r.layout ? ' · ' + esc(r.layout) : ''}</div><p class="txt">${esc(r.text)}</p>${fb}${btns}</div></div>`;
    }
    let media = '<span>not downloaded yet</span>';
    if (r.file) media = r.kind === 'clip' ? `<video src="${P.fileUrl(S.dir, r.file)}?v=${bust}" muted loop preload="metadata" onmouseenter="this.play()" onmouseleave="this.pause()"></video>` : `<img src="${P.fileUrl(S.dir, r.file)}?v=${bust}" alt="">`;
    const src = r.source ? (r.source.site === 'mine' ? 'my file' : esc(r.source.site)) : '';
    const words = r.searchWords && r.searchWords.length ? `<div class="small">search: ${esc(r.searchWords.join(' | '))}${src ? ' · from ' + src : ''}</div>` : '';
    const tooShort = r.tooShort ? '<div class="warn">This clip is shorter than its slot. Press Regenerate.</div>' : '';
    return `<div class="item" data-id="${r.id}">${time}<div class="thumb stock">${media}</div><div><div class="kind stock">Stock ${r.kind}</div><p class="txt">${esc(r.text)}</p>${words}${tooShort}${btns}</div></div>`;
  }).join('');
  $$('.item .btn').forEach((b) => (b.onclick = () => itemAct(b.dataset.act, b.closest('.item').dataset.id)));
  $$('.item .ov input').forEach((c) => (c.onchange = async () => { if (busy) return; const r = await call(P.setOverlay, c.closest('.item').dataset.id, c.checked); if (!r) render(); }));
}

async function itemAct(act, id) {
  if (busy) return;
  if (act === 'remove' && !confirm('Delete this B-roll item? The time goes to the item next to it.')) return;
  setBusy(true);
  const r = act === 'regenerate' ? await call(P.regenerate, id) : act === 'replace' ? await call(P.replace, id) : await call(P.remove, id);
  setBusy(false);
  if (r && r.note) toast(r.note);
  if (r) setStatus('Done', 1);
}
async function runStep(step) {
  if (busy) return; setBusy(true); setStatus('Starting...', 0.01);
  const r = await call(P.run, step); setBusy(false);
  if (r) setStatus('Done', 1);
}
$('#runAll').onclick = () => {
  if (!S.dir) return toast('Create or open a project first.');
  if (!S.project.audio || !S.project.face) return toast('Choose the audio and the face photo first.');
  runStep('all');
};
$$('[data-step]').forEach((b) => (b.onclick = () => runStep(b.dataset.step)));
$('#exportBtn').onclick = async () => {
  if (busy) return; if (!S.dir) return toast('Create or open a project first.');
  setBusy(true); setStatus('Starting export...', 0.01);
  const r = await call(P.exportVideo); setBusy(false);
  if (r) { setStatus('Done: final.mp4', 1); toast(r.note ? 'Video made. ' + r.note : 'Video made: final.mp4'); }
};
$('#showFinal').onclick = () => { if (S.dir && S.finalVideo) P.reveal(S.dir + '/' + S.finalVideo); };
$('#ovAllOn').onclick = () => { if (S.plan) call(P.setOverlayAll, true); };
$('#ovAllOff').onclick = () => { if (S.plan) call(P.setOverlayAll, false); };
$('#cancelBtn').onclick = () => { P.cancel(); setStatus('Cancelling...', null); };
$('#newProj').onclick = async () => { const r = await call(P.project, 'new'); if (r && r.dir) setStatus('Project ready.', 0); };
$('#openProj').onclick = async () => { const r = await call(P.project, 'open'); if (r && r.dir) setStatus('Project opened.', 0); };
async function pickInput(kind) {
  if (!S.dir) return toast('Create or open a project first.');
  if (kind === 'audio' && S.transcript && !confirm('New audio replaces the old transcript, moments, plan and slides. Continue?')) return;
  await call(P.pickInput, kind);
}
$('#audioPick').onclick = () => pickInput('audio');
$('#facePick').onclick = () => pickInput('face');
$('#overlayPick').onclick = () => pickInput('overlay');
$('#saveSettings').onclick = async () => {
  if (!S.dir) return toast('Create or open a project first.');
  const s = {}; for (const k of SET) s[k] = Number($('#' + k).value); s.searchOrder = $('#searchOrder').value;
  if (await call(P.saveSettings, s)) toast('Settings saved. Press Build plan to use them (search order works at once).');
};

// ---- keys (own screen, no prompt(): Electron does not support prompt()) ----
$('#keysBtn').onclick = async () => {
  $('#kOpenai').value = await P.getKey('openai'); $('#kGroq').value = await P.getKey('groq'); $('#kPexels').value = await P.getKey('pexels'); $('#kPixabay').value = await P.getKey('pixabay');
  const sm = await P.getKey('openai_model'); $('#kModel').value = sm && !/^(gpt-4\.1-mini|gpt-5\.6-luna)$/.test(sm) ? sm : await P.defaultModel(); $('#keysModal').hidden = false;
};
$('#keysCancel').onclick = () => ($('#keysModal').hidden = true);
$('#keysSave').onclick = async () => {
  const set = async (n, v) => { const r = await P.setKey(n, v.trim()); if (r && r.ok === false) throw new Error(r.error); };
  try { await set('openai', $('#kOpenai').value); await set('groq', $('#kGroq').value); await set('pexels', $('#kPexels').value); await set('pixabay', $('#kPixabay').value); await set('openai_model', $('#kModel').value); $('#keysModal').hidden = true; toast('Keys saved.'); }
  catch (e) { toast(e.message); }
};
(async () => { const r = await P.state(); if (r.ok) S = r.state; render(); if (S.dir) setStatus('Project opened.', 0); })();
