const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const P = window.pipeline;
{ const sel = document.querySelector('#theme'); let t = 'light'; try { t = localStorage.getItem('theme') || 'light'; } catch {}
  sel.value = t; document.documentElement.dataset.theme = t;
  sel.onchange = () => { document.documentElement.dataset.theme = sel.value; try { localStorage.setItem('theme', sel.value); } catch {} }; }
let S = { dir: null }, busy = false, bust = Date.now();
const SET = ['maxClips', 'maxSec', 'pngPct', 'clipImageRatio', 'maxStockRow', 'transition'];
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(window.__t); window.__t = setTimeout(() => t.classList.remove('show'), 3200); };
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60), r = s - m * 60; return String(m).padStart(2, '0') + ':' + r.toFixed(1).padStart(4, '0'); };

// Every IPC answer is {ok,state} or {ok:false,error}. A broken answer or a screen error is shown, never swallowed.
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
async function call(fn, ...a) {
  let r;
  try { r = await fn(...a); }
  catch (e) { const m = 'The app could not read the answer: ' + cleanErr(e); toast(m); setStatus(m, 0); return null; }
  if (!r.ok) { if (!r.cancelled) toast(r.error); setStatus(r.error, 0); try { render(); } catch (e) { console.error(e); } return null; }
  try { S = r.state; bust = Date.now(); render(); }
  catch (e) { console.error(e); const m = 'Screen error: ' + cleanErr(e); toast(m); setStatus(m, 0); return null; }
  return S;
}
async function refresh() { try { const r = await P.state(); if (r.ok) { S = r.state; bust = Date.now(); render(); } } catch (e) { console.error(e); } }

// ---- status line: step name, one bar for Run all, and a timer so a slow step never looks frozen ----
const STAGES = [['transcribe', 'Transcribe'], ['moments', 'Find avatar moments'], ['plan', 'Build plan'], ['stock', 'Get stock clips & images'], ['slides', 'Make PNG slides']];
let runMode = null, overall = 0, tStart = 0, timer = null, lastMsg = '';
const elapsed = () => { const s = Math.round((Date.now() - tStart) / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const paint = () => { $('#status').textContent = lastMsg + (busy ? '  ·  ' + elapsed() : ''); };
function setStatus(msg, pct) { lastMsg = msg || ''; if (pct != null) $('#bar').style.width = Math.round(pct * 100) + '%'; paint(); }
function setBusy(b) {
  busy = b; $('#cancelBtn').hidden = !b;
  if (b) { tStart = Date.now(); clearInterval(timer); timer = setInterval(paint, 1000); } else { clearInterval(timer); timer = null; }
  paint();
  $$('[data-step],#runAll,#newProj,#openProj,#audioPick,#facePick,#overlayPick,#saveSettings,#ovAllOn,#ovAllOff,#exportBtn').forEach((e) => { e.disabled = b; if (e.classList.contains('pick')) e.style.pointerEvents = b ? 'none' : ''; });
  $$('.item .btn,.item .ov input').forEach((e) => (e.disabled = b));
}
P.onProgress((p) => {
  let msg = p.msg, pct = p.pct;
  const i = STAGES.findIndex((x) => x[0] === p.step);
  if (runMode === 'all' && i >= 0) {
    msg = `Step ${i + 1} of ${STAGES.length}: ${STAGES[i][1]}. ${p.msg}`;
    overall = Math.max(overall, (i + Math.min(1, Math.max(0, p.pct || 0))) / STAGES.length); pct = overall;
  } else if (i >= 0) msg = `${STAGES[i][1]}: ${p.msg}`;
  setStatus(msg, pct);
});

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
  pvRefresh();
}

function renderPlan() {
  const list = $('#list'), cnt = $('#counts'), pl = S.plan, m = S.moments;
  if (!m && !pl) { cnt.innerHTML = ''; $('#breakdown').innerHTML = ''; list.innerHTML = '<div class="empty">Nothing yet. Choose the audio and the face photo, then press Run all steps.</div>'; return; }
  const rows = [];
  for (const a of (m ? m.moments : [])) rows.push({ t: 'av', ...a });
  for (const b of (pl ? pl.items : [])) rows.push({ t: 'br', ...b });
  rows.sort((x, y) => x.start - y.start);
  const c = pl ? pl.counts : { png: 0, clip: 0, image: 0, total: 0 };
  const reasons = {}; for (const b of (pl ? pl.items : [])) if (b.fallbackReason) { const r = b.fallbackReason.split(':')[0]; reasons[r] = (reasons[r] || 0) + 1; }
  const note = (pl && pl.adjusted ? `<span class="pill" title="Too many stock items for the 'max in a row' rule, so ${pl.adjusted} became PNG">${pl.adjusted} stock → PNG (row rule)</span>` : '') +
    Object.entries(reasons).map(([r, n]) => `<span class="pill" title="No good stock file was found, so a PNG slide was made">${n} stock → PNG (${esc(r)})</span>`).join('');
  cnt.innerHTML = `<span class="pill">Avatar moments <b>${m ? m.moments.length : 0}</b></span><span class="pill">PNG slides <b>${c.png}</b></span><span class="pill">Stock clips <b>${c.clip}</b></span><span class="pill">Stock images <b>${c.image}</b></span><span class="pill">B-roll total <b>${c.total}</b></span>${note}`;
  const fbN = pl ? pl.items.filter((i) => i.fallbackReason).length : 0, adjN = (pl && pl.adjusted) || 0, planned = Math.max(0, c.png - fbN - adjN);
  $('#breakdown').innerHTML = pl ? `${c.total} B-roll items: <b>${c.clip + c.image}</b> stock (${c.clip} clips, ${c.image} images) and <b>${c.png}</b> PNG slides. PNG slides: ${planned} chosen by the PNG % setting (${S.settings ? S.settings.pngPct : '?'}%)${adjN ? `, ${adjN} by the “max stock items in a row” rule` : ''}${fbN ? `, ${fbN} because no good stock file was found` : ''}.` : '';
  list.innerHTML = rows.map((r) => {
    const len = (r.end - r.start).toFixed(1) + ' s';
    const time = `<div data-start="${r.start}" title="Show this in the preview" class="time"><b>${fmt(r.start)} – ${fmt(r.end)}</b>${len}<br>${esc(r.id)}</div>`;
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
  $$('.time[data-start]').forEach((el) => (el.onclick = () => pvJump(Number(el.dataset.start))));
  $$('.item .btn').forEach((b) => (b.onclick = () => itemAct(b.dataset.act, b.closest('.item').dataset.id)));
  $$('.item .ov input').forEach((c) => (c.onchange = async () => { if (busy) return; const r = await call(P.setOverlay, c.closest('.item').dataset.id, c.checked); if (!r) render(); }));
}

async function itemAct(act, id) {
  if (busy) return;
  if (act === 'remove' && !confirm('Delete this B-roll item? The time goes to the item next to it.')) return;
  setBusy(true); let r = null;
  try { r = act === 'regenerate' ? await call(P.regenerate, id) : act === 'replace' ? await call(P.replace, id) : await call(P.remove, id); }
  finally { setBusy(false); await refresh(); }
  if (r && r.note) toast(r.note);
  if (r) setStatus('Done', 1);
}
async function runStep(step) {
  if (busy) return; runMode = step; overall = 0; setBusy(true); setStatus('Starting...', 0.01);
  let r = null;
  try { r = await call(P.run, step); } finally { runMode = null; setBusy(false); await refresh(); }
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
  let r = null; try { r = await call(P.exportVideo); } finally { setBusy(false); await refresh(); }
  if (r) { setStatus('Done: final.mp4', 1); toast(r.note ? 'Video made. ' + r.note : 'Video made: final.mp4'); }
};
$('#showFinal').onclick = () => { if (S.dir && S.finalVideo) P.reveal(S.dir + '/' + S.finalVideo); };
$('#ovAllOn').onclick = () => { if (S.plan) call(P.setOverlayAll, true); };
$('#ovAllOff').onclick = () => { if (S.plan) call(P.setOverlayAll, false); };
$('#cancelBtn').onclick = () => {
  P.cancel(); setStatus('Cancelling...', null);
  setTimeout(() => { if (busy && /^Cancelling/.test(lastMsg)) { runMode = null; setBusy(false); setStatus('Cancelled. Work in the background may take a few seconds to stop.', 0); refresh(); } }, 6000); // safety net: the screen never stays stuck
};
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); toast('Error: ' + cleanErr(e.reason)); });
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

// ---- live preview: your audio plays, and the picture follows the plan (no rendering needed) ----
const pv = { segs: [], key: null, src: '', raf: 0 };
const pvA = () => $('#pvAudio');
function pvDur() { const a = pvA(); if (isFinite(a.duration) && a.duration > 0) return a.duration; if (S.transcript && S.transcript.duration) return S.transcript.duration; return pv.segs.length ? pv.segs[pv.segs.length - 1].end : 0; }
function pvSegAt(t) { return pv.segs.find((x) => t >= x.start && t < x.end) || null; }
function pvLabel(t) { const d = pvDur(), f = (x) => Math.floor(x / 60) + ':' + String(Math.floor(x % 60)).padStart(2, '0'); $('#pvTime').textContent = f(t) + ' / ' + f(d); if (d) $('#pvSeek').value = Math.round((t / d) * 1000); }
function pvShow(t, force) {
  const a = pvA(), img = $('#pvImg'), vid = $('#pvVid'), ov = $('#pvOv'), playing = !a.paused, seg = pvSegAt(t), key = seg ? seg.id : 'gap';
  const url = (rel) => P.fileUrl(S.dir, rel) + '?v=' + bust;
  if (key !== pv.key || force) {
    pv.key = key; let im = '', vi = '', contain = false, tag = '';
    if (!seg || seg.t === 'av') { const clip = seg && S.avatar && S.avatar[seg.id]; if (clip) vi = clip; else im = S.project.face || ''; contain = true; tag = !seg ? 'No item here: face photo' : seg.type === 'intro' ? 'Avatar intro' : 'Avatar moment'; }
    else if (seg.kind === 'png') { im = seg.slide || ''; tag = 'PNG slide'; }
    else if (seg.kind === 'clip') { vi = seg.file || ''; tag = 'Stock clip'; }
    else { im = seg.file || ''; tag = 'Stock image'; }
    $('#pvStage').classList.toggle('contain', contain); $('#pvTag').textContent = tag + (seg && seg.t === 'br' ? ' · ' + seg.id : '');
    img.hidden = !im; if (im) img.src = url(im); else img.removeAttribute('src');
    vid.hidden = !vi; if (vi) { vid.src = url(vi); } else { vid.pause(); vid.removeAttribute('src'); }
    const ovOn = !!(seg && seg.t === 'br' && seg.overlay && S.project.overlay);
    ov.hidden = !ovOn; if (ovOn) { ov.src = url(S.project.overlay); ov.currentTime = 0; } else { ov.pause(); ov.removeAttribute('src'); }
  }
  if (!vid.hidden && seg) { const want = Math.max(0, t - seg.start); if (force || !playing || Math.abs(vid.currentTime - want) > 0.5) { try { vid.currentTime = isFinite(vid.duration) ? Math.min(want, vid.duration) : want; } catch {} } playing ? vid.play().catch(() => {}) : vid.pause(); }
  if (!ov.hidden) { playing ? ov.play().catch(() => {}) : ov.pause(); }
}
function pvTick() { const a = pvA(), t = a.currentTime; pvShow(t); pvLabel(t); if (!a.paused) pv.raf = requestAnimationFrame(pvTick); }
function pvJump(t) { const a = pvA(); if (!a.src) return; a.currentTime = Math.max(0, t); pvShow(a.currentTime, true); pvLabel(a.currentTime); $('#pvStage').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
function pvRefresh() {
  const has = !!(S.dir && S.project && S.project.audio), a = pvA();
  $('#pvPanel').hidden = !has; if (!has) return;
  const m = S.moments ? S.moments.moments : [], pl = S.plan ? S.plan.items : [];
  pv.segs = [...m.map((x) => ({ ...x, t: 'av' })), ...pl.map((x) => ({ ...x, t: 'br' }))].sort((x, y) => x.start - y.start);
  const src = P.fileUrl(S.dir, S.project.audio);
  if (pv.src !== src) { pv.src = src; a.src = src; }
  pv.key = null; const t = a.currentTime || 0; pvShow(t, true); pvLabel(t);
}
$('#pvPlay').onclick = () => { const a = pvA(); if (a.paused) a.play().catch((e) => toast('Cannot play the audio: ' + cleanErr(e))); else a.pause(); };
$('#pvSeek').oninput = (e) => { const a = pvA(), d = pvDur(); if (!a.src || !d) return; a.currentTime = (Number(e.target.value) / 1000) * d; pvShow(a.currentTime, true); pvLabel(a.currentTime); };
pvA().addEventListener('play', () => { $('#pvPlay').textContent = 'Pause'; cancelAnimationFrame(pv.raf); pv.raf = requestAnimationFrame(pvTick); });
pvA().addEventListener('pause', () => { $('#pvPlay').textContent = 'Play'; cancelAnimationFrame(pv.raf); pvShow(pvA().currentTime, true); });
pvA().addEventListener('loadedmetadata', () => pvLabel(pvA().currentTime));

(async () => { const r = await P.state(); if (r.ok) S = r.state; render(); if (S.dir) setStatus('Project opened.', 0); })();
