// ffmpeg-based export. Mirrors the canvas compositor in editor.html
// (drawSegVisual / compositeFrame) so the file matches the in-app preview.
//
// Strategy ("piece by piece"): the timeline is cut into frame-exact pieces:
//   - a STEADY piece = one segment on its own
//   - a ZONE piece   = crossfade between two neighbouring segments
// Each piece is its own small ffmpeg run (encoded with VideoToolbox, or x264 as
// a fallback), then all pieces are joined with the concat demuxer (stream copy,
// no re-encode) and the avatar's audio is muxed in. This keeps every ffmpeg
// filter graph tiny no matter how many cuts there are.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { ffmpegPath } = require('../../ffmpeg-bin');
const ops = require('./ffmpeg-ops');
const { app } = require('electron');

// sfxUrl values (e.g. 'assets/motion-sfx.mp3') are relative browser paths meant
// for editor.html's <video>/<audio> tags — they mean nothing to ffmpeg, which runs
// in a separate process with no concept of "relative to the HTML file". Resolve
// them to real files on disk, same asar-unpack rule as ffmpeg-bin.js's binaries.
function resolveAssetPath(relUrl) {
  if (path.isAbsolute(relUrl)) return relUrl;
  const rel0 = String(relUrl || '').replace(/^[/\\]+/, '');
  // The bundled assets live in src/assets/, but editor.html asks for 'assets/...'. Try both.
  const found = [rel0, path.join('src', rel0)].map(r => resolveAssetPathOnce(r)).find(p => fs.existsSync(p));
  return found || resolveAssetPathOnce(rel0);
}
function resolveAssetPathOnce(rel) {
  const appRoot = app.getAppPath();
  const candidates = [];
  // In development the files live directly below the app root. In a packaged
  // build Electron puts app code in app.asar, while electron-builder's
  // asarUnpack puts explicitly unpacked assets beside it in app.asar.unpacked.
  if (app.isPackaged) {
    const unpackedRoot = appRoot.includes(`${path.sep}app.asar`)
      ? appRoot.replace(`${path.sep}app.asar`, `${path.sep}app.asar.unpacked`)
      : path.join(process.resourcesPath, 'app.asar.unpacked');
    candidates.push(path.join(unpackedRoot, rel));
    candidates.push(path.join(appRoot, rel));
    candidates.push(path.join(process.resourcesPath, rel));
  } else {
    candidates.push(path.join(appRoot, rel));
  }
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

// ffmpeg is a separate process and cannot read files inside app.asar. If a file lives there,
// copy it to the temp work folder first. Returns a real on-disk path, or null if the file is missing.
function usableFile(p, work, name) {
  try {
    if (!p || !fs.existsSync(p)) return null;
    if (/\.asar[\\/]/.test(p) && !/\.asar\.unpacked/.test(p)) {
      const dest = path.join(work, name + path.extname(p));
      fs.copyFileSync(p, dest);
      return dest;
    }
    return p;
  } catch (_) { return null; }
}

const FPS = 30;
const RES_HEIGHT = { '1080p': 1080, '2k': 1440, '4k': 2160 };
const BITRATE = { 1080: '14M', 1440: '24M', 2160: '50M' };

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// Single source of truth for output geometry; the renderer asks for this
// (vem:get-geometry) so it can draw the mask/border PNGs at the exact size.
function computeGeometry({ renderW, renderH, res, framePct, height }) {
  const outH = even(RES_HEIGHT[res] || height || 1080);
  const scale = outH / renderH;
  const outW = even(renderW * scale);
  const boxW = even(outW * (framePct / 100));
  const boxH = even(outH * (framePct / 100));
  const boxX = 2 * Math.floor((outW - boxW) / 4);
  const boxY = 2 * Math.floor((outH - boxH) / 4);
  return { outW, outH, boxW, boxH, boxX, boxY, scale };
}

function runFfmpeg(args, ctl, onFrame) {
  return new Promise((resolve, reject) => {
    if (ctl.cancelled) return reject(new Error('cancelled'));
    const proc = spawn(ffmpegPath(), args);
    ctl.proc = proc;
    let tail = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-3000);
      if (onFrame) {
        const m = s.match(/frame=\s*(\d+)/g);
        if (m) onFrame(parseInt(m[m.length - 1].replace(/\D/g, ''), 10));
      }
    });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      ctl.proc = null;
      if (ctl.cancelled) return reject(new Error('cancelled'));
      if (code === null) return reject(new Error(`ffmpeg was killed (${signal || 'unknown signal'}): ${tail.slice(-800)}`));
      if (ctl.cancelled) reject(new Error('cancelled'));
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${tail.slice(-1500)}`));
    });
  });
}

function dataUrlToFile(dataUrl, dir, name) {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('Bad image data');
  const ext = m[1].includes('png') ? 'png' : m[1].includes('webp') ? 'webp' : 'jpg';
  const p = path.join(dir, `${name}.${ext}`);
  fs.writeFileSync(p, Buffer.from(m[2], 'base64'));
  return p;
}

// ---- timeline -> list of pieces ------------------------------------------
// Boundaries live on the gap-free VIRTUAL timeline (vStart/vEnd), not real b-roll time: trimming
// removes real footage at every cut, so segments' real start/end are NOT contiguous, but vStart/
// vEnd are (segment i starts exactly where segment i-1 left off). Using .end/.start here instead
// would put every piece after the first cut at the wrong output position, drifting further with
// every trim, and would seek into the trimmed-out footage inside makeLayer below.
function planPieces(segs, T, rate, N) {
  // boundaries with (clamped) crossfade half-widths, in virtual (gap-free) seconds
  const zones = [];
  for (let i = 0; i < segs.length - 1; i++) {
    const L = segs[i], R = segs[i + 1];
    let zs = null, ze = null, mid = Math.round((L.vEnd / rate) * FPS);
    if (T > 0) {
      const h = Math.min(T / 2, (L.vEnd - L.vStart) / 2, (R.vEnd - R.vStart) / 2);
      zs = Math.round(((L.vEnd - h) / rate) * FPS);
      ze = Math.round(((R.vStart + h) / rate) * FPS);
    }
    if (zs === null || ze <= zs) { zs = ze = mid; }
    zones.push({ zs, ze });
  }
  const pieces = [];
  let c = 0;
  for (let i = 0; i < segs.length; i++) {
    const zs = i < segs.length - 1 ? Math.min(zones[i].zs, N) : N;
    if (zs > c) pieces.push({ kind: 'steady', seg: i, f0: c, n: zs - c });
    c = Math.max(c, zs);
    if (i < segs.length - 1) {
      const ze = Math.min(zones[i].ze, N);
      if (ze > c) pieces.push({ kind: 'zone', left: i, right: i + 1, f0: c, n: ze - c });
      c = Math.max(c, ze);
    }
  }
  if (c < N && pieces.length) pieces[pieces.length - 1].n += N - c; // rounding remainder
  return pieces;
}

// ---- filtergraph for one segment "layer" ----------------------------------
// ---- Part B: one segment of the finished video from a file on disk ------------
// seg.type === 'media'. seg.media = { path, isVideo, w, h, dur, startAt, fit: 'cover' | 'contain' }
//  - video: the file is CUT to the slot (never sped up or slowed down). Too short = last frame is held.
//  - image: shown for the whole slot.
//  - cover = fills the frame (crops the edges). contain = whole picture inside a blurred copy of itself
//    (used for the face photo and avatar clips, so a face is never cut or stretched).
// seg.overlay = true puts the project overlay clip (muted, looping) on top.
function makeMediaLayer(ctx, seg, f0, n, label, inputs) {
  const { outW: W, outH: H } = ctx.g;
  const m = seg.media, D = n / FPS, tw0 = f0 / FPS, parts = [];
  const add = (args) => { inputs.push(args); return inputs.length - 1; };
  const local = Math.max(0, tw0 - seg.vStart); // seconds since this segment started
  let src;
  if (m.isVideo) {
    const at = Math.max(0, Math.min((m.startAt || 0) + local, (m.dur || 1) - 0.1)); // never seek past the end
    const i = add(['-ss', at.toFixed(4), '-t', (D + 0.4).toFixed(4), '-i', m.path]);
    src = `[${i}:v]setpts=PTS-STARTPTS,fps=${FPS},tpad=stop_mode=clone:stop_duration=${(D + 1).toFixed(3)}`;
  } else {
    const i = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', m.path]);
    src = `[${i}:v]setpts=PTS-STARTPTS,fps=${FPS}`;
  }
  const out = seg.overlay && ctx.overlay ? `${label}0` : label;
  const sameShape = Math.abs((m.w / Math.max(1, m.h)) / (W / H) - 1) <= 0.02;
  if (m.fit === 'contain' && !sameShape) {
    parts.push(`${src},split[${label}s1][${label}s2]`);
    parts.push(`[${label}s1]scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},boxblur=25:3[${label}bb]`);
    parts.push(`[${label}s2]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic[${label}ff]`);
    parts.push(`[${label}bb][${label}ff]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2,setsar=1,format=yuv420p[${out}]`);
  } else if (m.fit === 'contain') {
    parts.push(`${src},scale=${W}:${H}:flags=bicubic,setsar=1,format=yuv420p[${out}]`);
  } else {
    parts.push(`${src},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},setsar=1,format=yuv420p[${out}]`);
  }
  if (seg.overlay && ctx.overlay) {
    const ov = ctx.overlay, off = tw0 % Math.max(0.1, ov.dur);
    const o = add(['-stream_loop', '-1', '-t', (off + D + 0.6).toFixed(3), '-i', ov.path]); // only the picture is used: the clip is muted
    parts.push(`[${o}:v]trim=start=${off.toFixed(4)}:duration=${(D + 0.4).toFixed(4)},setpts=PTS-STARTPTS,fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H},setsar=1,format=${ov.alpha ? 'rgba' : 'gbrp'}[${label}ov]`);
    if (ov.alpha) parts.push(`[${out}][${label}ov]overlay=format=auto:shortest=1,format=yuv420p[${label}]`);
    else parts.push(`[${out}]format=gbrp[${label}bg];[${label}bg][${label}ov]blend=all_mode=screen:shortest=1,format=yuv420p[${label}]`); // no alpha: black becomes see-through
  }
  return parts;
}

function makeLayer(ctx, seg, f0, n, label, inputs) {
  if (seg.type === 'media') return makeMediaLayer(ctx, seg, f0, n, label, inputs);
  const { g, spec, media } = ctx;
  const { outW, outH, boxW, boxH, boxX, boxY } = g;
  const rate = spec.rate, D = n / FPS, tw0 = f0 / FPS; // wall-clock start of piece
  const add = (args) => { inputs.push(args); return inputs.length - 1; };
  const parts = [];

  if (seg.type === 'avatar') {
    const a = add(['-ss', tw0.toFixed(4), '-t', (D + 0.4).toFixed(4), '-i', spec.avatarPath]);
    parts.push(`[${a}:v]setpts=PTS-STARTPTS,fps=${FPS},scale=${outW}:${outH}:flags=bicubic,setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=3[${label}]`);
    return parts;
  }

  // ---- background ----
  if (spec.bgPath && media.bgDur > 0) {
    const off = tw0 % media.bgDur;
    const b = add(['-stream_loop', '-1', '-i', spec.bgPath]);
    parts.push(`[${b}:v]trim=start=${off.toFixed(4)}:duration=${(D + 0.4).toFixed(4)},setpts=PTS-STARTPTS,fps=${FPS},scale=${outW}:${outH}:flags=bicubic,setsar=1,format=yuv420p[${label}bg]`);
  } else {
    parts.push(`color=c=black:s=${outW}x${outH}:r=${FPS}:d=${(D + 1).toFixed(3)},setsar=1,format=yuv420p[${label}bg]`);
  }

  // ---- foreground source (stretched into the frame box, like the canvas does) ----
  const T = spec.transDur, L = Math.max(0.001, seg.end - seg.start);
  const flip = seg.mirrored ? ',hflip' : '';
  let head; // filter chain that ends with a boxW x boxH stream
  const fin = `scale=${boxW}:${boxH}:flags=bicubic,setsar=1${flip}`;
  if (seg.type === 'broll') {
    // tw0*rate is a position on the gap-free VIRTUAL timeline (total elapsed content, all
    // segments back to back with no gaps). Re-base it onto this segment's own real start so the
    // seek lands on the real footage this piece should show, skipping every trimmed gap before it.
    const t0 = seg.start + Math.max(0, (tw0 * rate) - seg.vStart);
    const i = add(['-ss', t0.toFixed(4), '-t', (D * rate + 0.6).toFixed(4), '-i', spec.brollPath]);
    let crop = '';
    if (spec.brollCrop > 0) {
      const k = media.brollW / Math.max(1, spec.previewBrollW || media.brollW); // preview px -> source px
      const cp = Math.max(0, Math.min(Math.round(spec.brollCrop * k), media.brollW / 2 - 2, media.brollH / 2 - 2));
      if (cp > 0) crop = `crop=iw-${2 * cp}:ih-${2 * cp}:${cp}:${cp},`;
    }
    head = `[${i}:v]setpts=(PTS-STARTPTS)/${rate},fps=${FPS},tpad=stop_mode=clone:stop_duration=3,${crop}${fin}`;
  } else if (seg.type === 'image' || (seg.type === 'replaced' && seg.replaceKind === 'image')) {
    const i = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', seg._file]);
    head = `[${i}:v]setpts=PTS-STARTPTS,fps=${FPS},${fin}`;
  } else if (seg.type === 'replaced') {
    const dur = seg._dur || 1;
    const u0 = Math.min(Math.max(0, (dur * ((tw0 * rate) - seg.vStart + T)) / L), Math.max(0, dur - 0.1));
    const k = (dur * rate) / L; // source seconds of the clip consumed per wall second
    const i = add(['-ss', u0.toFixed(4), '-t', (D * k + 0.6).toFixed(4), '-i', seg.replacePath]);
    head = `[${i}:v]setpts=(PTS-STARTPTS)/${k.toFixed(6)},fps=${FPS},tpad=stop_mode=clone:stop_duration=3,${fin}`;
  } else {
    throw new Error('Unknown segment type: ' + seg.type);
  }

  // ---- Ken Burns zoom (sub-pixel via perspective, driven by source-time progress) ----
  const zp = spec.zoomPct / 100;
  let zoom = '';
  if (zp > 0) {
    const p = `clip((((${f0}+in)/${FPS})*${rate}-${seg.vStart})/${L},0,1)`;
    const z = `(1+${zp}*${p})`;
    const a = `(W/2*(1-1/${z}))`, b = `(W/2*(1+1/${z}))`, c = `(H/2*(1-1/${z}))`, d = `(H/2*(1+1/${z}))`;
    zoom = `,perspective=x0='${a}':y0='${c}':x1='${b}':y1='${c}':x2='${a}':y2='${d}':x3='${b}':y3='${d}':eval=frame:interpolation=cubic`;
  }
  parts.push(`${head}${zoom},format=yuv420p[${label}fg]`);

  // ---- rounded-corner mask, overlay onto the background, then border ring ----
  const m = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', ctx.maskPath]);
  parts.push(`[${m}:v]format=gray,fps=${FPS}[${label}m]`);
  parts.push(`[${label}fg][${label}m]alphamerge[${label}fa]`);
  if (ctx.borderPath) {
    const bo = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', ctx.borderPath]);
    parts.push(`[${label}bg][${label}fa]overlay=${boxX}:${boxY}:format=auto[${label}o]`);
    parts.push(`[${bo}:v]format=rgba,fps=${FPS}[${label}b]`);
    parts.push(`[${label}o][${label}b]overlay=${boxX}:${boxY}:format=auto,format=yuv420p[${label}base]`);
  } else {
    parts.push(`[${label}bg][${label}fa]overlay=${boxX}:${boxY}:format=auto,format=yuv420p[${label}base]`);
  }

  // ---- avatar PiP overlay (composited on top, B-roll/image/replaced segments only — avatar
  // full-screen segments returned early above and are never touched by this). Mirrors
  // drawPipOverlay() in editor.html: crop the avatar around a focus point at a zoom level,
  // mask it into a circle/rounded-box, optional border ring, then overlay at (boxX,boxY).
  // Piece splitting (planPieces -> splitPiecesForPip, below) guarantees every piece here sees
  // exactly ONE PiP keyframe for its whole duration, so this stays a static filter chain.
  let pipApplied = false;
  if (spec.pip && spec.pip.enabled) {
    const vt = tw0 * rate;
    const kf = pickPipKeyframe(vt, spec.pip.keyframes);
    if (kf && kf.boxW > 0 && kf.boxH > 0 && kf._maskPath) {
      const aw = media.avatarW || 1, ah = media.avatarH || 1;
      const boxAspect = kf.boxW / kf.boxH;
      let srcW, srcH;
      if (aw / ah > boxAspect) { srcH = ah / Math.max(1, kf.zoom); srcW = srcH * boxAspect; }
      else { srcW = aw / Math.max(1, kf.zoom); srcH = srcW / boxAspect; }
      srcW = Math.max(2, Math.min(Math.round(srcW), aw));
      srcH = Math.max(2, Math.min(Math.round(srcH), ah));
      let sx = Math.round(kf.focusX * aw - srcW / 2), sy = Math.round(kf.focusY * ah - srcH / 2);
      sx = Math.max(0, Math.min(aw - srcW, sx)); sy = Math.max(0, Math.min(ah - srcH, sy));
      const av = add(['-ss', tw0.toFixed(4), '-t', (D + 0.4).toFixed(4), '-i', spec.avatarPath]);
      parts.push(`[${av}:v]setpts=PTS-STARTPTS,fps=${FPS},tpad=stop_mode=clone:stop_duration=3,crop=${srcW}:${srcH}:${sx}:${sy},scale=${kf.boxW}:${kf.boxH}:flags=bicubic,setsar=1,format=yuv420p[${label}pipfg]`);
      const pm = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', kf._maskPath]);
      parts.push(`[${pm}:v]format=gray,fps=${FPS}[${label}pipm]`);
      parts.push(`[${label}pipfg][${label}pipm]alphamerge[${label}pipa]`);
      if (kf._borderPath) {
        const pb = add(['-loop', '1', '-framerate', String(FPS), '-t', (D + 0.4).toFixed(4), '-i', kf._borderPath]);
        parts.push(`[${label}base][${label}pipa]overlay=${kf.boxX}:${kf.boxY}:format=auto[${label}pipo]`);
        parts.push(`[${pb}:v]format=rgba,fps=${FPS}[${label}pipb]`);
        parts.push(`[${label}pipo][${label}pipb]overlay=${kf.boxX}:${kf.boxY}:format=auto,format=yuv420p[${label}]`);
      } else {
        parts.push(`[${label}base][${label}pipa]overlay=${kf.boxX}:${kf.boxY}:format=auto,format=yuv420p[${label}]`);
      }
      pipApplied = true;
    }
  }
  if (!pipApplied) parts.push(`[${label}base]null[${label}]`);
  return parts;
}

// Which PiP keyframe is in effect at virtual-timeline time vt (seconds) — same step-function
// rule as activePipKeyframe() in editor.html: the keyframe with the largest t <= vt wins, and
// it holds until the next one. keyframes[0].t is always 0 (the global default).
function pickPipKeyframe(vt, keyframes) {
  let active = keyframes[0];
  for (const kf of keyframes) { if (kf.t <= vt + 1e-6) active = kf; else break; }
  return active;
}

// Inserts extra split points into 'steady' pieces wherever a PiP keyframe's time falls strictly
// inside them, so every piece makeLayer() sees has exactly one constant PiP style throughout
// (crossfade 'zone' pieces are left whole — a PiP change scheduled mid-crossfade takes effect
// at the following steady piece instead; crossfades are short and this keeps the filter graph
// simple). Avatar-only steady pieces are left alone (no PiP ever applies to them).
function splitPiecesForPip(pieces, segs, spec) {
  if (!spec.pip || !spec.pip.enabled || !spec.pip.keyframes.length) return pieces;
  const rate = spec.rate;
  const out = [];
  for (const pc of pieces) {
    if (pc.kind !== 'steady' || segs[pc.seg].type === 'avatar') { out.push(pc); continue; }
    const splits = [];
    for (const kf of spec.pip.keyframes) {
      const f = Math.round((kf.t / rate) * FPS);
      if (f > pc.f0 && f < pc.f0 + pc.n) splits.push(f);
    }
    if (!splits.length) { out.push(pc); continue; }
    splits.sort((a, b) => a - b);
    let cursor = pc.f0;
    for (const f of splits) { out.push({ ...pc, f0: cursor, n: f - cursor }); cursor = f; }
    out.push({ ...pc, f0: cursor, n: pc.f0 + pc.n - cursor });
  }
  return out;
}

// Builds the filter graph that composites every finalized AI-motion-graphics card (see
// finalizeMotions()/buildMotionExportAsset() in editor.html) on top of the already-concatenated
// base video ([0:v]). One motion = one small filter subgraph:
//   1. its pre-rendered enter-frame PNG sequence, played once at FPS ("[e]")
//   2. its last enter frame looped for (hold+exit) seconds, with ffmpeg's own alpha fade-out
//      applied over the last exitMs ("[h]") — every style's exit is the same simple fade, per
//      spec, so this is the one place the whole export handles ALL ten styles' exits identically
//   3. concat(e,h) -> one clip covering the card's full on-screen span, starting at its own t=0
//   4. delayed via setpts to the card's actual wall-clock start time
//   5. overlaid onto the running composite at (0,0) (cards are pre-rendered at full RENDER_W x
//      RENDER_H canvas size, transparent elsewhere — ffmpeg's own scale=outW:outH upscale of that
//      full-frame layer, same as every other visual element in this pipeline, is what keeps
//      fixed-pixel values like padding/line-widths in drawGenericCard() correctly proportioned
//      at 1080p/2K/4K rather than needing every constant in that function rescaled by hand),
//      gated to only that card's [start,end) window via enable='between(t,...)'
// startInputIdx is the ffmpeg -i index of the first motion input (2 if the avatar audio input was
// already added at index 1, else 1) — every motion consumes exactly 2 inputs (enter sequence +
// held/faded still), in order.
function buildMotionOverlayFilter(motionAssets, FPS, startInputIdx, outW, outH, baseLabel='[0:v]', inputArgs=[]) {
  const filterParts = [`${baseLabel}format=yuv420p[mbase0]`];
  let prevLabel = 'mbase0';
  let nextIdx = startInputIdx;
  motionAssets.forEach((m, i) => {
    const enterIdx = nextIdx++;
    inputArgs.push(['-framerate', String(FPS), '-start_number', '0', '-i', path.join(m.dir, 'f%05d.png')]);
    const holdSec = m.holdMs / 1000, exitSec = m.exitMs / 1000;
    const heldIdx = nextIdx++;
    inputArgs.push(['-loop', '1', '-framerate', String(FPS), '-t', (holdSec + exitSec).toFixed(4), '-i', m.settledPath]);

    const enterSecActual = m.framePaths.length / FPS;
    // Center card: moving background clip UNDER the card layer, fading in/out with it.
    if (m.bgClipPath) {
      const totalSec = enterSecActual + holdSec + exitSec;
      const clipIdx = nextIdx++;
      inputArgs.push(['-stream_loop', '-1', '-t', totalSec.toFixed(4), '-i', m.bgClipPath]);
      filterParts.push(`[${clipIdx}:v]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},fps=${FPS},format=rgba,` +
        `fade=t=in:st=0:d=${Math.max(0.05, enterSecActual).toFixed(4)}:alpha=1,` +
        `fade=t=out:st=${Math.max(0, totalSec - exitSec).toFixed(4)}:d=${Math.max(0.001, exitSec).toFixed(4)}:alpha=1,` +
        `setpts=PTS-STARTPTS+${m.t.toFixed(4)}/TB[mbg${i}]`);
      filterParts.push(`[${prevLabel}][mbg${i}]overlay=x=0:y=0:eof_action=pass:enable='between(t,${m.t.toFixed(4)},${(m.t + totalSec).toFixed(4)})'[mbgo${i}]`);
      prevLabel = `mbgo${i}`;
    }
    filterParts.push(`[${enterIdx}:v]format=rgba,setpts=PTS-STARTPTS[me${i}]`);
    filterParts.push(`[${heldIdx}:v]format=rgba,fade=t=out:st=${holdSec.toFixed(4)}:d=${Math.max(0.001, exitSec).toFixed(4)}:alpha=1,setpts=PTS-STARTPTS[mh${i}]`);
    filterParts.push(`[me${i}][mh${i}]concat=n=2:v=1:a=0[mc${i}]`);
    filterParts.push(`[mc${i}]scale=${outW}:${outH}:flags=bicubic,setpts=PTS-STARTPTS+${m.t.toFixed(4)}/TB[mcd${i}]`);
    const endT = m.t + enterSecActual + holdSec + exitSec;
    filterParts.push(`[${prevLabel}][mcd${i}]overlay=x=0:y=0:enable='between(t,${m.t.toFixed(4)},${endT.toFixed(4)})'[movl${i}]`);
    filterParts.push(`[movl${i}]format=yuv420p[mout${i}]`);
    prevLabel = `mout${i}`;
  });
  return { inputArgs, filter: filterParts.join(';'), outLabel: prevLabel };
}

// ---- main entry -------------------------------------------------------------
// spec: see editor.html (buildRenderSpec). onProgress({pct, fps, etaSec, phase})
async function render(spec, onProgress, ctl) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vem-render-'));
  const t0 = Date.now();
  try {
    const segs = spec.segments;
    if (!segs.length) throw new Error('Nothing to render.');
    const g = computeGeometry(spec);

    // temp files for masks + generated images
    const maskPath = path.join(work, 'mask.png');
    if (spec.maskPng) fs.writeFileSync(maskPath, Buffer.from(spec.maskPng.split(',')[1], 'base64')); // Part B segments are full frame: no mask needed
    let borderPath = null;
    if (spec.borderPng) {
      borderPath = path.join(work, 'border.png');
      fs.writeFileSync(borderPath, Buffer.from(spec.borderPng.split(',')[1], 'base64'));
    }
    const media = { bgDur: 0 };
    if (spec.brollPath) { // Without B-roll mode has no b-roll file
      const bp = await ops.probe(spec.brollPath);
      media.brollW = bp.width; media.brollH = bp.height;
    }
    if (spec.bgPath) media.bgDur = (await ops.probe(spec.bgPath)).duration;
    // Part B: spec.audioPath = the uploaded audio (the soundtrack of the whole video), spec.totalDur = its length.
    // Without them the old behaviour stays: the avatar file gives the audio and the length.
    const audioFile = spec.audioPath || spec.avatarPath;
    const ap = audioFile ? await ops.probe(audioFile) : { width: 0, height: 0, duration: 0, hasAudio: false };
    media.avatarW = ap.width; media.avatarH = ap.height;

    // PiP overlay assets: mask (+ optional border) PNGs were pre-rendered in the browser
    // (buildRenderSpec, same pattern as the main box mask/border) — just decode them to disk.
    if (spec.pip && spec.pip.enabled) {
      spec.pip.keyframes.sort((a, b) => a.t - b.t);
      spec.pip.keyframes.forEach((kf, idx) => {
        kf._maskPath = path.join(work, `pipmask${idx}.png`);
        fs.writeFileSync(kf._maskPath, Buffer.from(kf.maskPng.split(',')[1], 'base64'));
        if (kf.borderPng) {
          kf._borderPath = path.join(work, `pipborder${idx}.png`);
          fs.writeFileSync(kf._borderPath, Buffer.from(kf.borderPng.split(',')[1], 'base64'));
        }
      });
    }

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.type === 'image') s._file = s.imgPath || dataUrlToFile(s.imgData, work, `img${i}`);
      if (s.type === 'replaced' && s.replaceKind === 'image') s._file = s.replacePath;
      if (s.type === 'replaced' && s.replaceKind === 'video') s._dur = (await ops.probe(s.replacePath)).duration;
    }

    const N = Math.round((spec.totalDur || ap.duration) * FPS);
    let pieces = planPieces(segs, spec.transDur, spec.rate, N);
    pieces = splitPiecesForPip(pieces, segs, spec);
    const ctx = { g, spec, media, maskPath, borderPath, overlay: spec.overlay || null };
    const bitrate = BITRATE[g.outH] || '20M';
    // Build the complete base-video filter graph in memory and encode it once.
    // The old implementation launched one FFmpeg process per timeline piece, then
    // concatenated the encoded pieces. That was robust but expensive: a video with
    // many cuts could require hundreds of FFmpeg launches and repeated codec setup.
    // All pieces are now fed into one filter graph and concatenated frame-exactly,
    // so the final video is encoded only once (plus one retry if hardware encoding fails).
    let useHw = true;
    let doneFrames = 0;
    const emit = (cur, phase) => {
      const frames = Math.min(N, Math.max(doneFrames, cur));
      const el = (Date.now() - t0) / 1000;
      onProgress && onProgress({
        pct: Math.min(99, (frames / Math.max(1, N)) * 100),
        fps: frames / Math.max(el, 0.001),
        etaSec: frames ? (el / frames) * (N - frames) : null,
        phase: phase || 'Rendering',
      });
    };
    const allInputs = [];
    const baseFilters = [];
    const pieceLabels = [];

    for (let pi = 0; pi < pieces.length; pi++) {
      const pc = pieces[pi];
      const aLabel = `piece${pi}a`;
      const bLabel = `piece${pi}b`;
      const vLabel = `piece${pi}v`;
      let parts;
      if (pc.kind === 'steady') {
        parts = makeLayer(ctx, segs[pc.seg], pc.f0, pc.n, aLabel, allInputs);
        parts.push(`[${aLabel}]trim=duration=${(pc.n / FPS).toFixed(6)},setpts=PTS-STARTPTS[${vLabel}]`);
      } else {
        parts = [
          ...makeLayer(ctx, segs[pc.left], pc.f0, pc.n, aLabel, allInputs),
          ...makeLayer(ctx, segs[pc.right], pc.f0, pc.n, bLabel, allInputs),
          `[${aLabel}][${bLabel}]xfade=transition=fade:duration=${(pc.n / FPS).toFixed(4)}:offset=0,trim=duration=${(pc.n / FPS).toFixed(6)},setpts=PTS-STARTPTS[${vLabel}]`,
        ];
      }
      baseFilters.push(...parts);
      pieceLabels.push(vLabel);
    }

    if (pieceLabels.length === 1) {
      baseFilters.push(`[${pieceLabels[0]}]format=yuv420p[basev]`);
    } else {
      baseFilters.push(`${pieceLabels.map(x => `[${x}]`).join('')}concat=n=${pieceLabels.length}:v=1:a=0[basev]`);
    }

    let audioInputIdx = -1;
    if (ap.hasAudio) {
      audioInputIdx = allInputs.length;
      allInputs.push(['-i', audioFile]);
    }

    const warnings = [];
    const motionAssets = (spec.motions || []).map((m, i) => {
      const dir = path.join(work, `motion${i}`);
      fs.mkdirSync(dir);
      const framePaths = m.frames.map((durl, fi) => {
        const p = path.join(dir, `f${String(fi).padStart(5, '0')}.png`);
        fs.writeFileSync(p, Buffer.from(durl.split(',')[1], 'base64'));
        return p;
      });
      if (!framePaths.length) throw new Error(`Motion ${i + 1} has no rendered frames.`);
      let bgClipPath = null;
      if (m.bgClipPath) {
        bgClipPath = usableFile(m.bgClipPath, work, `bgclip${i}`);
        if (!bgClipPath) warnings.push(`Center card ${i + 1}: background clip file not found (${m.bgClipPath}) - it has no moving clip.`);
      }
      return { t: m.t, holdMs: m.holdMs, exitMs: m.exitMs, dir, framePaths, settledPath: framePaths[framePaths.length - 1], bgClipPath };
    });

    const motionBuilt = motionAssets.length
      ? buildMotionOverlayFilter(motionAssets, FPS, allInputs.length, g.outW, g.outH, '[basev]', allInputs)
      : null;

    const sfxSchedule = (spec.motionSfxSchedule || []).filter(s => s && (s.sfxUrl || s.sfxPath));
    const sfxFilters = [];
    let audioMap;
    if (ap.hasAudio && sfxSchedule.length) {
      const sfxInputs = [];
      sfxSchedule.forEach(s => {
        const cands = [s.sfxPath, resolveAssetPath(s.sfxUrl)].filter(Boolean);
        let sfxPath = null;
        for (const c of cands) { sfxPath = usableFile(c, work, `sfx_${path.basename(c)}`); if (sfxPath) break; }
        if (!sfxPath) {
          console.warn(`[render] skipping unavailable motion SFX: ${cands.join(' | ')} (from ${s.sfxUrl})`);
          const msg = `Sound file not found: ${s.sfxUrl} - cards using it are silent.`;
          if (!warnings.includes(msg)) warnings.push(msg);
          return;
        }
        sfxInputs.push({ ...s, sfxPath });
      });
      if (sfxInputs.length) {
        const sfxLabels = [`[${audioInputIdx}:a]`];
        sfxInputs.forEach((item, i) => {
          const idx = allInputs.length;
          allInputs.push(['-i', item.sfxPath]);
          const delayMs = Math.max(0, Math.round(Number(item.t) * 1000));
          const volume = Math.max(0, Math.min(1, Number(item.volume) || 0));
          sfxFilters.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${volume.toFixed(3)},adelay=${delayMs}|${delayMs}[sfxa${i}]`);
          sfxLabels.push(`[sfxa${i}]`);
        });
        sfxFilters.push(`${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:duration=first:normalize=0[amixed]`);
        audioMap = ['-map', '[amixed]', '-c:a', 'aac', '-b:a', '192k', '-shortest'];
      } else {
        audioMap = ['-map', `${audioInputIdx}:a`, '-c:a', 'aac', '-b:a', '192k', '-shortest'];
      }
    } else if (ap.hasAudio) {
      audioMap = ['-map', `${audioInputIdx}:a`, '-c:a', 'aac', '-b:a', '192k', '-shortest'];
    } else {
      audioMap = [];
    }

    const filterParts = [...baseFilters];
    if (motionBuilt) filterParts.push(motionBuilt.filter);
    if (sfxFilters.length) filterParts.push(...sfxFilters);
    // Final safety net before the encoder: x264/VideoToolbox both refuse to open on odd
    // dimensions, a missing/variable frame rate or a non-4:2:0 pixel format ("Error while opening
    // encoder ... incorrect parameters such as bit_rate, rate, width or height"). Force all three.
    filterParts.push(`[${motionBuilt ? motionBuilt.outLabel : 'basev'}]scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=bicubic,fps=${FPS},setsar=1,format=yuv420p[vfinal]`);

    const fin = ['-y', '-hide_banner', '-loglevel', 'error', '-stats'];
    allInputs.forEach(args => fin.push(...args));
    fin.push('-filter_complex', filterParts.join(';'));
    fin.push('-map', '[vfinal]', '-r', String(FPS));
    fin.push(...audioMap);

    const phaseLabel = motionAssets.length ? 'Compositing video, motion graphics and audio' : 'Rendering video and adding audio';
    // Try the fast hardware encoder first, then progressively more forgiving software encoders,
    // so one picky encoder setting can never make the whole export fail.
    const attempts = [
      { name: 'hardware (VideoToolbox)', hw: true,  args: ['-c:v', 'h264_videotoolbox', '-b:v', bitrate, '-pix_fmt', 'yuv420p', '-profile:v', 'high'] },
      { name: 'x264',                    hw: false, args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high'] },
      { name: 'x264 (safe mode)',        hw: false, args: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p'] },
      { name: 'MPEG-4 (last resort)',    hw: false, args: ['-c:v', 'mpeg4', '-q:v', '2', '-pix_fmt', 'yuv420p'] },
    ];
    const renderArgs = (codecArgs) => [...fin, ...codecArgs, '-movflags', '+faststart', spec.outPath];
    emit(0, phaseLabel);
    const failures = [];
    let ok = false;
    for (const at of attempts) {
      try {
        doneFrames = 0;
        await runFfmpeg(renderArgs(at.args), ctl, (f) => { doneFrames = Math.max(doneFrames, f); emit(f, phaseLabel); });
        useHw = at.hw;
        ok = true;
        break;
      } catch (err) {
        if (String(err.message) === 'cancelled') throw err;
        const msg = String(err.message || err).replace(/\s+/g, ' ').slice(-300);
        console.error(`[render] ${at.name} failed (output ${g.outW}x${g.outH}): ${msg}`);
        failures.push(`${at.name}: ${msg}`);
        try { if (spec.outPath && fs.existsSync(spec.outPath)) fs.unlinkSync(spec.outPath); } catch (_) {}
      }
    }
    if (!ok) throw new Error(`Every encoder failed for a ${g.outW}x${g.outH} export. ${failures.join(' | ')}`);
    const finalHw = useHw;
    onProgress && onProgress({ pct: 100, fps: 0, etaSec: 0, phase: 'Done' });
    return { outPath: spec.outPath, seconds: (Date.now() - t0) / 1000, frames: N, pieces: pieces.length, hardware: finalHw, warnings };
  } catch (err) {
    try { if (spec.outPath && fs.existsSync(spec.outPath)) fs.unlinkSync(spec.outPath); } catch (_) {}
    throw err;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { render, computeGeometry, planPieces, RES_HEIGHT };
