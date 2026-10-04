// Runs the Part 1 steps in order and edits plan items. Main process only. Talks to modules, saves everything in the project folder.
const fs = require('fs');
const path = require('path');
const project = require('./modules/project');
const { transcribe } = require('./modules/transcribe');
const { detectMoments } = require('./modules/moments');
const { buildPlan, counts, mulberry32 } = require('./modules/broll-plan');
const { pickStyles, STYLES } = require('./modules/slides/pick');
const { SlideEngine, POOL } = require('./modules/slides');
const stock = require('./modules/stock');
const overlay = require('./modules/overlay');
const exporter = require('./modules/export');
const { probe } = require('./modules/media-probe');
const { clipMap } = require('./modules/avatar-interface');
const keystore = require('./keystore');
const bin = require('./ffmpeg-bin');
const { spawn } = require('child_process');

const { DEFAULT_MODEL } = require('./modules/openai');
const OLD_MODELS = /^(gpt-4\.1-mini|gpt-5\.6-luna)$/; // old defaults: ignored, the one model is gpt-5.6-sol
const ctx = { dir: null, s: null, abort: null, busy: false, engine: null };
let emit = () => {};
const setEmitter = (f) => { emit = f; };
const progress = (step, msg, pct) => emit({ step, msg, pct });

function keys() {
  return { openai: keystore.getKey('openai'), groq: keystore.getKey('groq'), pexels: keystore.getKey('pexels'), pixabay: keystore.getKey('pixabay'), model: (() => { const m = (keystore.getKey('openai_model') || '').trim(); return m && !OLD_MODELS.test(m) ? m : DEFAULT_MODEL; })() };
}
function view() {
  if (!ctx.dir) return { dir: null };
  const s = ctx.s, t = s.transcript;
  const avatar = {}; try { for (const [id, c] of clipMap(ctx.dir)) avatar[id] = path.relative(ctx.dir, c.path); } catch {}
  return { dir: ctx.dir, busy: ctx.busy, project: s.project, settings: s.settings, moments: s.moments, plan: s.plan, avatar,
    finalVideo: fs.existsSync(path.join(ctx.dir, 'final.mp4')) ? 'final.mp4' : null,
    transcript: t ? { duration: t.duration, words: t.words.length, language: t.language || '' } : null };
}
function openDir(dir) { ctx.dir = dir; ctx.s = project.load(dir); return view(); }
const recount = (p) => { p.counts = counts(p.items); p.fallback = p.items.filter((i) => i.fallbackReason).length; };
function save(name, data) { project.writeJson(ctx.dir, project.FILES[name], data); ctx.s[name] = data; }
function need(c, msg) { if (!c) throw new Error(msg); }
function guard() { need(ctx.dir, 'Open or create a project first.'); need(!ctx.busy, 'Another step is running. Wait or press Cancel.'); }
function checkCancel(sig) { const g = sig || (ctx.abort && ctx.abort.signal); if (g && g.aborted) throw new Error('cancelled'); }
// Cancel answers at once. The running work gets the stop signal and its slide windows are closed; if it is
// slow to stop, the busy flag is cleared after 3 s at the latest, and a stopped run can no longer save files.
async function exclusive(fn, { waitStop = false } = {}) { // waitStop: export kills ffmpeg at once and cleans up, so Cancel waits for that
  guard(); ctx.busy = true;
  const ac = new AbortController(); ctx.abort = ac;
  const release = () => { if (ctx.abort === ac) { ctx.busy = false; ctx.abort = null; } };
  const work = Promise.resolve().then(fn);
  work.then(release, release);
  const stopped = new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new Error('cancelled'))));
  stopped.catch(() => {}); // when nobody races it (export), the rejection must not be reported as an error
  try { return await (waitStop ? work : Promise.race([work, stopped])); }
  catch (e) { if (ac.signal.aborted) { const t = setTimeout(release, 3000); if (t.unref) t.unref(); } throw e; }
}
const cancel = () => {
  if (ctx.abort) ctx.abort.abort();
  if (ctx.engine) { try { ctx.engine.destroy(); } catch {} ctx.engine = null; }
};

// ---------- inputs ----------
function setInput(kind, src) { // kind: 'audio' | 'face'
  need(ctx.dir, 'Open or create a project first.'); need(!ctx.busy, 'A step is running.');
  const name = project.copyInto(ctx.dir, src, kind);
  const p = { ...ctx.s.project, [kind]: name, [kind + 'Name']: path.basename(src) };
  save('project', p);
  if (kind === 'audio') { // new audio: old results are no longer valid
    for (const f of ['transcript', 'moments', 'plan']) { try { fs.unlinkSync(path.join(ctx.dir, project.FILES[f])); } catch {} ctx.s[f] = null; }
    project.clearSlides(ctx.dir);
    try { fs.unlinkSync(path.join(ctx.dir, 'final.mp4')); } catch {} // the old video no longer matches the new audio
  }
  return view();
}
function saveSettings(s) { need(ctx.dir, 'Open or create a project first.'); save('settings', project.cleanSettings(s)); return view(); }

// ---------- steps ----------
async function stepTranscribe() {
  const k = keys(); need(ctx.s.project.audio, 'Choose the audio file first.');
  progress('transcribe', 'Starting transcription', 0.02);
  const t = await transcribe({ audioPath: path.join(ctx.dir, ctx.s.project.audio), key: k.groq, ffmpeg: bin.ffmpegPath(), ffprobe: bin.ffprobePath(),
    onProgress: (m, p) => progress('transcribe', m, p), signal: ctx.abort.signal });
  save('transcript', t);
  for (const f of ['moments', 'plan']) { try { fs.unlinkSync(path.join(ctx.dir, project.FILES[f])); } catch {} ctx.s[f] = null; }
  project.clearSlides(ctx.dir);
}
async function stepMoments() {
  const k = keys(); need(ctx.s.transcript, 'Transcribe the audio first.');
  progress('moments', 'OpenAI is choosing the avatar moments', 0.1);
  const m = await detectMoments({ transcript: ctx.s.transcript, settings: ctx.s.settings, key: k.openai, model: k.model, signal: ctx.abort.signal });
  save('moments', m);
  try { fs.unlinkSync(path.join(ctx.dir, project.FILES.plan)); } catch {} ctx.s.plan = null;
  project.clearSlides(ctx.dir);
}
function stepPlan() {
  need(ctx.s.moments && ctx.s.transcript, 'Find the avatar moments first.');
  progress('plan', 'Building the B-roll plan', 0.5);
  project.clearSlides(ctx.dir);
  save('plan', buildPlan({ moments: ctx.s.moments.moments, transcript: ctx.s.transcript, settings: ctx.s.settings }));
}
function engine() { if (!ctx.engine) ctx.engine = new SlideEngine(); return ctx.engine; }
async function stepSlides({ onlyMissing = true } = {}) {
  const k = keys(); need(ctx.s.plan, 'Build the plan first.');
  const sig = ctx.abort.signal, plan = ctx.s.plan;
  const todo = plan.items.filter((i) => i.kind === 'png' && !(onlyMissing && i.slide && fs.existsSync(path.join(ctx.dir, i.slide))));
  if (!todo.length) { progress('slides', 'No PNG slides to make', 1); return; }
  progress('slides', 'OpenAI is choosing styles and layouts', 0.02);
  const picks = await pickStyles({ items: todo, key: k.openai, model: k.model, rng: Math.random, signal: sig });
  checkCancel(sig);
  progress('slides', `Making slides: 0 of ${todo.length} (each one takes about 20 to 60 s)`, 0.05);
  const pm = new Map(picks.map((p) => [p.id, p]));
  let done = 0, failed = 0, next = 0;
  const worker = async () => {
    while (next < todo.length) {
      checkCancel(sig);
      const it = todo[next++], pk = pm.get(it.id);
      try {
        const r = await engine().render(it, { dir: ctx.dir, key: k.openai, model: k.model, style: pk.style, layout: pk.layout });
        checkCancel(sig);
        it.slide = r.slide; it.style = r.style; it.layout = r.layout; delete it.error;
      } catch (e) { checkCancel(sig); it.slide = null; it.error = String(e.message || e).slice(0, 300); failed++; }
      done++; recount(plan); save('plan', plan);
      progress('slides', `Slide ${done} of ${todo.length}${failed ? ` (${failed} failed)` : ''}`, 0.05 + 0.95 * (done / todo.length));
    }
  };
  await Promise.all(Array.from({ length: Math.min(POOL, todo.length) }, worker));
  if (failed) throw new Error(`${failed} slide(s) failed. Press Regenerate on them.`);
}

// ---------- stock clips and images (Part A) ----------
async function verifyMedia(file, item, cand) { // the site's numbers are not trusted: check the real file
  const m = await probe(bin.ffprobePath(), file), need = item.end - item.start;
  if (!m.hasVideo) throw new Error('not a video or image');
  if (cand.kind === 'clip') {
    if (m.width < 1900 || m.height < 1060) throw new Error('smaller than 1080p');
    if (m.duration < need - 0.1) throw new Error('shorter than the slot');
  } else if (m.width < 1200 || m.height < 650) throw new Error('image too small');
  return m;
}
function applyFill(it, r) {
  const old = it.file;
  it.file = r.rel; it.source = { site: r.cand.site, id: r.cand.id, page: r.cand.page || '' };
  it.tried = [...new Set([...(it.tried || []), stock.srcKey(r.cand)])].slice(-30);
  if (r.info && r.info.duration) it.fileDuration = Math.round(r.info.duration * 1000) / 1000; else delete it.fileDuration;
  delete it.fallbackReason; delete it.fallbackFrom; delete it.tooShort; delete it.error;
  if (old && old !== it.file) { try { fs.unlinkSync(path.join(ctx.dir, old)); } catch {} }
}
function toPng(it, reason) { // no good stock: this item becomes a PNG slide (made by the slide engine)
  it.fallbackFrom = it.kind; it.fallbackReason = reason; it.kind = 'png'; it.slide = null;
  for (const f of ['file', 'source', 'fileDuration', 'tooShort', 'style', 'layout']) delete it[f];
}
function needStockKey(k) { need(k.pexels || k.pixabay, 'Add a Pexels or Pixabay key in Keys first.'); }
async function stepStock({ withSlides = true } = {}) {
  const k = keys(); need(ctx.s.plan, 'Build the plan first.'); needStockKey(k);
  const sig = ctx.abort.signal, plan = ctx.s.plan;
  const todo = plan.items.filter((i) => (i.kind === 'clip' || i.kind === 'image') && !(i.file && fs.existsSync(path.join(ctx.dir, i.file))));
  if (todo.length) {
    progress('stock', 'OpenAI is writing the search words', 0.02);
    const missing = todo.filter((i) => !(i.searchWords && i.searchWords.length));
    if (missing.length) { const m = await stock.makeSearchWords({ items: missing, key: k.openai, model: k.model, signal: ctx.abort.signal }); for (const i of missing) i.searchWords = m.get(i.id); save('plan', plan); }
    const sctx = stock.newCtx({ settings: ctx.s.settings, keys: k, items: plan.items, signal: sig });
    let done = 0, next = 0, stop = false; const errs = [];
    const worker = async () => {
      while (next < todo.length && !stop) {
        checkCancel(sig);
        const it = todo[next++];
        try {
          const r = await stock.fillItem(it, sctx, ctx.dir, verifyMedia);
          checkCancel(sig);
          if (r.ok) applyFill(it, r); else toPng(it, r.reason);
        } catch (e) {
          if (e.name === 'AbortError' || sig.aborted) { stop = true; throw new Error('cancelled'); }
          if (e.fatal) { stop = true; throw e; }
          errs.push(e.message);
        }
        done++; recount(plan); save('plan', plan);
        progress('stock', `Stock ${done} of ${todo.length}${plan.fallback ? ` (${plan.fallback} became PNG)` : ''}`, 0.05 + 0.95 * (done / todo.length));
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
    if (errs.length) throw new Error(`${errs.length} item(s) could not be searched (${errs[0]}). Press "Get stock" again to retry them.`);
  }
  recount(plan); save('plan', plan);
  if (withSlides) await stepSlides({ onlyMissing: true });
}
async function runStep(name) {
  return exclusive(async () => {
    {
      if (name === 'transcribe') await stepTranscribe();
      else if (name === 'moments') await stepMoments();
      else if (name === 'plan') stepPlan();
      else if (name === 'slides') await stepSlides();
      else if (name === 'stock') await stepStock();
      else if (name === 'all') {
        needStockKey(keys()); // fail now, before the slow steps
        const sig = ctx.abort.signal;
        if (!ctx.s.transcript) await stepTranscribe(); checkCancel(sig);
        await stepMoments(); checkCancel(sig); stepPlan(); checkCancel(sig); await stepStock({ withSlides: false }); checkCancel(sig); await stepSlides({ onlyMissing: false });
      } else throw new Error('Unknown step.');
      progress(name, 'Done', 1);
      return view();
    }
  });
}

// ---------- item buttons ----------
const findItem = (id) => { const i = ctx.s.plan && ctx.s.plan.items.find((x) => x.id === id); need(i, 'Item not found.'); return i; };
async function regenerate(id) {
  return exclusive(async () => {
    const it = findItem(id);
    if (it.kind !== 'png') { await regenStock(it); return view(); }
    const k = keys();
    const others = STYLES.filter((s) => s !== it.style), style = others[Math.floor(Math.random() * others.length)];
    const sig = ctx.abort.signal;
    progress('item', 'Making a new slide', 0.3);
    const r = await engine().render(it, { dir: ctx.dir, key: k.openai, model: k.model, style, layout: '', avoidLayout: it.layout });
    checkCancel(sig);
    it.slide = r.slide; it.style = r.style; it.layout = r.layout; delete it.error;
    recount(ctx.s.plan); save('plan', ctx.s.plan);
    return view();
  });
}

async function regenStock(it) { // another clip / image for the same slot. The old file is kept if nothing else is found.
  const k = keys(); needStockKey(k);
  const plan = ctx.s.plan, signal = ctx.abort.signal, oldWords = it.searchWords || [];
  const sctx = stock.newCtx({ settings: ctx.s.settings, keys: k, items: plan.items, signal });
  progress('item', 'Looking for another ' + it.kind, 0.2);
  if (!oldWords.length) it.searchWords = (await stock.makeSearchWords({ items: [it], key: k.openai, model: k.model, signal })).get(it.id);
  let r = await stock.fillItem(it, sctx, ctx.dir, verifyMedia);
  if (!r.ok) {
    progress('item', 'Trying new search words', 0.5);
    const w = (await stock.makeSearchWords({ items: [it], key: k.openai, model: k.model, signal, avoid: it.searchWords })).get(it.id);
    it.searchWords = w; r = await stock.fillItem(it, sctx, ctx.dir, verifyMedia);
  }
  if (!r.ok) { it.searchWords = oldWords.length ? oldWords : it.searchWords; throw new Error(`No other ${it.kind} found (${r.reason}). The old one is kept.`); }
  applyFill(it, r); recount(ctx.s.plan); save('plan', ctx.s.plan);
}
function convertToPng(src, out) {
  return new Promise((resolve, reject) => {
    const q = spawn(bin.ffmpegPath(), ['-y', '-i', src, '-frames:v', '1', '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black', out]);
    let err = ''; q.stderr.on('data', (d) => (err += d)); q.on('error', reject);
    q.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Image convert failed: ' + err.slice(-300)))));
  });
}
async function replace(id, src) {
  guard();
  const it = findItem(id);
  if (it.kind !== 'png') return replaceStock(it, src);
  need(stock.IMAGE_EXT.includes(path.extname(src).toLowerCase()), 'A PNG slide can only be replaced with an image.');
  const rel = 'slides/' + it.id + '.png';
  await convertToPng(src, path.join(ctx.dir, rel));
  it.slide = rel; it.style = 'custom'; delete it.layout; delete it.error;
  recount(ctx.s.plan); save('plan', ctx.s.plan);
  return view();
}

async function replaceStock(it, src) { // my own video or image in a stock slot
  const ext = path.extname(src).toLowerCase(), isVideo = stock.VIDEO_EXT.includes(ext);
  need(isVideo || stock.IMAGE_EXT.includes(ext), 'Choose a video (mp4, mov, m4v, webm) or an image (jpg, png, webp).');
  const m = await probe(bin.ffprobePath(), src), slot = it.end - it.start;
  need(m.hasVideo, 'This file has no picture.');
  if (isVideo) need(m.duration >= slot - 0.05, `This video is ${m.duration.toFixed(1)} s but the slot needs ${slot.toFixed(1)} s. Choose a longer one.`);
  const rel = 'stock/' + it.id + '-mine' + ext, old = it.file;
  fs.copyFileSync(src, path.join(ctx.dir, rel));
  if (old && old !== rel) { try { fs.unlinkSync(path.join(ctx.dir, old)); } catch {} }
  it.file = rel; it.kind = isVideo ? 'clip' : 'image'; it.source = { site: 'mine', id: path.basename(src) };
  if (isVideo) it.fileDuration = Math.round(m.duration * 1000) / 1000; else delete it.fileDuration;
  for (const f of ['fallbackReason', 'fallbackFrom', 'tooShort', 'error']) delete it[f];
  recount(ctx.s.plan); save('plan', ctx.s.plan);
  return view();
}
function remove(id) {
  guard();
  const items = ctx.s.plan.items, i = items.findIndex((x) => x.id === id); need(i >= 0, 'Item not found.');
  const it = items[i], prev = items[i - 1], next = items[i + 1]; let note = '';
  const adj = [];
  if (prev && Math.abs(prev.end - it.start) < 0.02) adj.push({ n: prev, len: it.end - prev.start, side: 'prev' });
  if (next && Math.abs(next.start - it.end) < 0.02) adj.push({ n: next, len: next.end - it.start, side: 'next' });
  // the neighbour in time takes the free time; a stock clip only if it is long enough, else the other side
  const fits = (a) => a.n.kind !== 'clip' || !a.n.fileDuration || a.n.fileDuration >= a.len - 0.05;
  const pick = adj.find(fits) || adj[0];
  if (pick) {
    if (pick.side === 'prev') pick.n.end = it.end; else pick.n.start = it.start;
    if (!fits(pick)) { pick.n.tooShort = true; note = 'The neighbour clip is now shorter than its slot. Press Regenerate on it.'; }
  } else note = 'This part of the video now has no B-roll.';
  items.splice(i, 1);
  for (const f of [it.slide, it.file]) if (f) { try { fs.unlinkSync(path.join(ctx.dir, f)); } catch {} }
  recount(ctx.s.plan); save('plan', ctx.s.plan);
  return { ...view(), note };
}
// ---------- overlay ----------
async function setOverlayClip(src) { // one silent clip for the whole project
  need(ctx.dir, 'Open or create a project first.'); need(!ctx.busy, 'A step is running.');
  await overlay.validate(bin.ffprobePath(), src);
  const name = project.copyInto(ctx.dir, src, 'overlay');
  save('project', { ...ctx.s.project, overlay: name, overlayName: path.basename(src) });
  return view();
}
function setOverlay(id, on) { // per B-roll item only: avatar moments are not plan items, so they can never get it
  guard(); const it = findItem(id);
  need(!on || ctx.s.project.overlay, 'Choose the overlay clip first (left side, Inputs).');
  it.overlay = !!on; save('plan', ctx.s.plan); return view();
}
function setOverlayAll(on) {
  guard(); need(ctx.s.plan, 'Build the plan first.'); need(!on || ctx.s.project.overlay, 'Choose the overlay clip first (left side, Inputs).');
  for (const it of ctx.s.plan.items) it.overlay = !!on; save('plan', ctx.s.plan); return view();
}
// ---------- export (Part B) ----------
let exportOpts = {}; // tests only: { height, transition }
async function exportVideo() {
  return exclusive(async () => {
    const ctl = { cancelled: false, proc: null };
    const onAbort = () => { ctl.cancelled = true; if (ctl.proc) { try { ctl.proc.kill('SIGKILL'); } catch {} } };
    ctx.abort.signal.addEventListener('abort', onAbort);
    progress('export', 'Checking the files', 0.01);
    let note = '';
    try {
      const r = await exporter.exportVideo(ctx.dir, { project: ctx.s.project, moments: ctx.s.moments, plan: ctx.s.plan }, {
        ctl, transition: ctx.s.settings.transition, ...exportOpts, onProgress: (p) => progress('export', `${p.phase || 'Rendering'}${p.etaSec ? ` (about ${Math.max(1, Math.round(p.etaSec))} s left)` : ''}`, Math.min(0.99, p.pct / 100)) });
      note = r.warnings.join(' ');
      progress('export', 'Done: final.mp4', 1);
    } catch (e) { if (ctl.cancelled) throw new Error('cancelled'); throw e; }
    finally { ctx.abort && ctx.abort.signal.removeEventListener('abort', onAbort); }
    return { ...view(), note };
  }, { waitStop: true });
}
const itemKind = (id) => findItem(id).kind;
function shutdown() { if (ctx.engine) ctx.engine.destroy(); }
module.exports = { setEmitter, openDir, view, setInput, saveSettings, runStep, regenerate, replace, remove, cancel, shutdown, DEFAULT_MODEL, setOverlayClip, setOverlay, setOverlayAll, itemKind, exportVideo, _setExportOpts: (o) => { exportOpts = o || {}; } };
