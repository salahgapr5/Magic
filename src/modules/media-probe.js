// ffprobe helper: width, height, duration, has video / audio stream of a media file.
const { spawn } = require('child_process');
function probe(ffprobe, file) {
  return new Promise((resolve, reject) => {
    const q = spawn(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
    let out = '', err = '';
    q.stdout.on('data', (d) => (out += d)); q.stderr.on('data', (d) => (err += d)); q.on('error', reject);
    q.on('close', (c) => {
      if (c !== 0) return reject(new Error('This file cannot be read as media. ' + err.slice(-200)));
      try {
        const j = JSON.parse(out), v = (j.streams || []).find((s) => s.codec_type === 'video'), a = (j.streams || []).some((s) => s.codec_type === 'audio');
        const dur = Number((j.format && j.format.duration) || (v && v.duration) || 0);
        resolve({ hasVideo: !!v, hasAudio: a, width: v ? v.width : 0, height: v ? v.height : 0, duration: Number.isFinite(dur) ? dur : 0, frames: v && v.nb_frames ? Number(v.nb_frames) : null });
      } catch (e) { reject(e); }
    });
  });
}
module.exports = { probe };
