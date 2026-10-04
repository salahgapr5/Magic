// Part C writes avatar-clips.json, Part B (export) reads it. If the file or a clip is missing, the face photo is used.
// {version:1, clips:[{id,file,width,height,hasAudio}]}  id = the moment id (intro, av2, av3...), file = path inside the project folder.
const fs = require('fs'), path = require('path');
function readAvatarClips(dir) {
  try { const j = JSON.parse(fs.readFileSync(path.join(dir, 'avatar-clips.json'), 'utf8')); return Array.isArray(j.clips) ? j.clips : []; } catch { return []; }
}
// Map: moment id -> { path (absolute), width, height, hasAudio }. Only clips whose file really exists are listed.
function clipMap(dir) {
  const m = new Map();
  for (const c of readAvatarClips(dir)) {
    if (!c || typeof c.id !== 'string' || typeof c.file !== 'string') continue;
    const p = path.resolve(dir, c.file);
    if (!p.startsWith(path.resolve(dir) + path.sep)) continue; // a clip must live inside the project folder
    try { if (fs.statSync(p).size > 0) m.set(c.id, { path: p, width: c.width || 0, height: c.height || 0, hasAudio: !!c.hasAudio }); } catch {}
  }
  return m;
}
module.exports = { readAvatarClips, clipMap };
