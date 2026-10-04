// Project folder: all files are written here. No other module talks to another except through these files.
const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
  maxClips: 4,          // max avatar clips (the intro counts as one)
  maxSec: 15,           // max seconds per avatar clip (the intro ignores this)
  pngPct: 70,           // percent of B-roll that is PNG slides
  clipImageRatio: 4,    // stock clips per 1 stock image
  maxStockRow: 3,       // max stock items in a row
  searchOrder: 'pexels', // which stock site is searched first: 'pexels' | 'pixabay'
  transition: 0,        // export: crossfade seconds between avatar and B-roll (0 = hard cut)
};
const FILES = { transcript: 'transcript.json', moments: 'moments.json', plan: 'plan.json', settings: 'settings.json', project: 'project.json' };

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const d of ['slides', 'stock', 'avatar']) fs.mkdirSync(path.join(dir, d), { recursive: true });
}
function readJson(dir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
}
function writeJson(dir, name, data) {
  const p = path.join(dir, name), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p); // atomic: a crash never leaves half a file
}
function cleanSettings(s) {
  const n = (v, d, lo, hi) => { v = Number(v); if (!Number.isFinite(v)) v = d; return Math.min(hi, Math.max(lo, v)); };
  const o = { ...DEFAULT_SETTINGS, ...(s || {}) };
  return {
    maxClips: Math.round(n(o.maxClips, 4, 1, 30)),
    maxSec: n(o.maxSec, 15, 5, 120),
    pngPct: n(o.pngPct, 70, 0, 100),
    clipImageRatio: n(o.clipImageRatio, 4, 0.5, 50),
    maxStockRow: Math.round(n(o.maxStockRow, 3, 1, 20)),
    searchOrder: o.searchOrder === 'pixabay' ? 'pixabay' : 'pexels',
    transition: Math.round(n(o.transition, 0, 0, 1) * 100) / 100,
  };
}
function load(dir) {
  ensure(dir);
  const settings = cleanSettings(readJson(dir, FILES.settings));
  if (!readJson(dir, FILES.settings)) writeJson(dir, FILES.settings, settings); // a new project always has its settings file
  return {
    dir,
    project: readJson(dir, FILES.project) || { version: 1, audio: null, face: null, audioName: null, faceName: null },
    settings,
    transcript: readJson(dir, FILES.transcript),
    moments: readJson(dir, FILES.moments),
    plan: readJson(dir, FILES.plan),
  };
}
function copyInto(dir, src, base) {
  const ext = path.extname(src).toLowerCase();
  for (const f of fs.readdirSync(dir)) if (f.startsWith(base + '.')) fs.unlinkSync(path.join(dir, f));
  const name = base + ext;
  fs.copyFileSync(src, path.join(dir, name));
  return name;
}
function clearSlides(dir, keep = []) {
  const d = path.join(dir, 'slides');
  if (!fs.existsSync(d)) return;
  for (const f of fs.readdirSync(d)) if (!keep.includes('slides/' + f)) { try { fs.unlinkSync(path.join(d, f)); } catch {} }
}
module.exports = { DEFAULT_SETTINGS, FILES, ensure, readJson, writeJson, cleanSettings, load, copyInto, clearSlides };
