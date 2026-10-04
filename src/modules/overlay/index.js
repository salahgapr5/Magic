// Overlay: one silent clip, muted and looping, shown over B-roll items only (never avatar moments). OFF by default.
// Per item the plan.json field is overlay:true/false. The export (Part 2C) does the looping and muting.
const path = require('path');
const { probe } = require('../media-probe');
const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
async function validate(ffprobe, file) {
  if (!VIDEO_EXT.includes(path.extname(file).toLowerCase())) throw new Error('The overlay must be a video file (mp4, mov, m4v, webm, mkv).');
  const m = await probe(ffprobe, file);
  if (!m.hasVideo || m.duration < 0.5) throw new Error('This overlay clip is not a video or is shorter than half a second.');
  return m;
}
module.exports = { validate, VIDEO_EXT };
