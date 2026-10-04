// Part B: export. Builds the timeline from moments.json + plan.json (+ avatar-clips.json) and gives it to the
// SalMedia ffmpeg code (ffmpeg-render.js). One encode, the uploaded audio is the soundtrack of the whole video.
//   avatar moment: avatar clip if it exists, else the face photo for the moment's time range
//   B-roll item:   PNG slide / stock clip (cut to the slot) / stock image, overlay only if the item has overlay:true
const fs = require('fs'), path = require('path');
const ops = require('./ffmpeg-ops');
const { render } = require('./ffmpeg-render');
const { clipMap } = require('../avatar-interface');

const EPS = 0.04; // gaps / overlaps smaller than this (seconds) are rounding, not real

function rel(dir, f) { return path.join(dir, f); }
function need(c, msg) { if (!c) throw new Error(msg); }

// Pure timeline logic (tested alone): spans in time order, no holes, no overlaps, ends at `total`.
// spans: [{start,end,...}] -> same spans, clamped, with face-photo stills ({hole:true}) in any hole.
function tile(spans, total) {
  const out = []; let cur = 0, holes = 0;
  const list = spans.slice().sort((a, b) => a.start - b.start);
  for (const s of list) {
    const e = Math.min(s.end, total);
    if (e - Math.max(s.start, cur) < 0.01) continue; // fully inside the previous span, or empty
    const st = Math.max(s.start, cur);
    if (st - cur > EPS) { out.push({ hole: true, start: cur, end: st }); holes++; }
    out.push({ ...s, start: st > cur && st - cur <= EPS ? cur : st, end: e });
    cur = e;
  }
  // The audio file is often a little longer than the last item (encoder padding): stretch the last item, no face flash.
  if (total - cur > 0.5 || !out.length) { out.push({ hole: true, start: cur, end: total }); holes++; }
  else if (total > cur) out[out.length - 1].end = total;
  return { spans: out, holes };
}

async function check(dir, { project, moments, plan }) {
  need(project && project.audio && fs.existsSync(rel(dir, project.audio)), 'Choose the audio file first.');
  need(project.face && fs.existsSync(rel(dir, project.face)), 'Choose the face photo first (it is shown where there is no avatar clip).');
  need(moments && plan, 'Run the steps first: transcript, avatar moments and the plan.');
  const noPng = plan.items.filter((i) => i.kind === 'png' && !(i.slide && fs.existsSync(rel(dir, i.slide))));
  const noStock = plan.items.filter((i) => i.kind !== 'png' && !(i.file && fs.existsSync(rel(dir, i.file))));
  need(!noPng.length, `${noPng.length} PNG slide(s) are not made yet (${noPng.slice(0, 3).map((i) => i.id).join(', ')}). Press "Make PNG slides" first.`);
  need(!noStock.length, `${noStock.length} stock item(s) have no file yet (${noStock.slice(0, 3).map((i) => i.id).join(', ')}). Press "Get stock clips & images" first.`);
}

// Returns { spec, warnings } for ffmpeg-render. Reads every file with ffprobe, so a broken file stops here with its name.
async function buildSpec(dir, { project, moments, plan, height, transition }) {
  await check(dir, { project, moments, plan });
  const warnings = [], audioPath = rel(dir, project.audio);
  const A = await ops.probe(audioPath);
  need(A.hasAudio && A.duration > 0.5, 'The audio file has no sound or is too short.');
  const total = A.duration;
  const facePath = rel(dir, project.face), F = await ops.probe(facePath);
  const face = { path: facePath, isVideo: false, w: F.width, h: F.height, dur: 0, startAt: 0, fit: 'contain' };
  const clips = clipMap(dir);
  const pr = async (file, what) => { try { return await ops.probe(file); } catch (e) { throw new Error(`Cannot read ${what} (${path.basename(file)}): ${String(e.message).slice(0, 120)}`); } };

  const spans = [
    ...moments.moments.map((m) => ({ start: m.start, end: m.end, kind: 'avatar', id: m.id })),
    ...plan.items.map((i) => ({ start: i.start, end: i.end, kind: 'broll', item: i })),
  ];
  const t = tile(spans, total);
  if (t.holes) warnings.push(`${t.holes} part(s) of the video had no avatar and no B-roll. The face photo is shown there.`);

  const segs = []; let stills = 0, shortClips = 0, ovSkipped = 0;
  const wantOv = plan.items.some((i) => i.overlay);
  let overlay = null;
  if (wantOv && project.overlay && fs.existsSync(rel(dir, project.overlay))) {
    const o = await pr(rel(dir, project.overlay), 'the overlay clip');
    overlay = { path: rel(dir, project.overlay), dur: o.duration, alpha: /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/.test(o.pixFmt || '') && !/^pal8/.test(o.pixFmt || '') };
  } else if (wantOv) warnings.push('Some items have the overlay switched on, but the overlay clip is missing. The overlay is skipped.');

  for (const s of t.spans) {
    const seg = { type: 'media', vStart: s.start, vEnd: s.end, start: s.start, end: s.end, overlay: false };
    const slot = s.end - s.start;
    if (s.hole) { seg.media = face; stills++; }
    else if (s.kind === 'avatar') {
      const c = clips.get(s.id);
      if (c) {
        const P = await pr(c.path, `avatar clip ${s.id}`);
        if (P.duration < slot - 0.5) warnings.push(`Avatar clip ${s.id} is ${P.duration.toFixed(1)} s but the moment is ${slot.toFixed(1)} s. The last picture is held.`);
        seg.media = { path: c.path, isVideo: true, w: P.width, h: P.height, dur: P.duration, startAt: 0, fit: 'contain' };
      } else { seg.media = face; stills++; }
    } else {
      const it = s.item;
      if (it.kind === 'png') { const f = rel(dir, it.slide), P = await pr(f, `slide ${it.id}`); seg.media = { path: f, isVideo: false, w: P.width, h: P.height, dur: 0, startAt: 0, fit: 'cover' }; }
      else {
        const f = rel(dir, it.file), P = await pr(f, `${it.kind} ${it.id}`), isVideo = it.kind === 'clip';
        need(P.width > 0, `Stock file ${it.id} has no picture.`);
        if (isVideo && P.duration < slot - 0.1) { shortClips++; }
        seg.media = { path: f, isVideo, w: P.width, h: P.height, dur: P.duration, startAt: 0, fit: 'cover' };
      }
      if (it.overlay) { if (overlay) seg.overlay = true; else ovSkipped++; }
    }
    segs.push(seg);
  }
  if (shortClips) warnings.push(`${shortClips} stock clip(s) are shorter than their slot. The last picture is held.`);
  const spec = {
    segments: segs, rate: 1, transDur: Math.max(0, Number(transition) || 0), zoomPct: 0, brollCrop: 0,
    renderW: 1920, renderH: 1080, res: height ? 'custom' : '1080p', height, framePct: 100, // height = tests only (small output)
    audioPath, totalDur: total, overlay, pip: null, motions: [], motionSfxSchedule: [],
  };
  return { spec, warnings, stats: { total, avatarClips: segs.filter((x) => x.media.isVideo && !x.overlay && x.media !== face && x.media.fit === 'contain').length, stills, segments: segs.length } };
}

// Writes <dir>/final.mp4. ctl = { cancelled, proc } (the caller sets ctl.cancelled and kills ctl.proc to cancel).
// Temp work folder is removed by render() on success, error and cancel; a half-written file is removed too.
async function exportVideo(dir, data, { onProgress, ctl, height, transition } = {}) {
  ctl = ctl || { cancelled: false, proc: null };
  const { spec, warnings, stats } = await buildSpec(dir, { ...data, height, transition });
  const final = path.join(dir, 'final.mp4'), part = path.join(dir, 'final.part.mp4');
  spec.outPath = part;
  try { fs.unlinkSync(part); } catch {}
  try {
    const r = await render(spec, onProgress, ctl);
    fs.renameSync(part, final);
    return { file: 'final.mp4', seconds: r.seconds, warnings: [...warnings, ...(r.warnings || [])], stats };
  } catch (e) {
    try { fs.unlinkSync(part); } catch {}
    throw e;
  }
}
module.exports = { exportVideo, buildSpec, tile, check };
