// Groq transcription with word timestamps -> transcript.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sleep } = require('../openai');

const CHUNK_SEC = 600;      // long audio is cut in 10 minute pieces (Groq file size limit)
const SINGLE_MAX_SEC = 1200; // up to 20 minutes goes in one piece

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const q = spawn(bin, args); let err = '', out = '';
    q.stdout.on('data', (d) => (out += d)); q.stderr.on('data', (d) => (err += d));
    q.on('error', reject);
    q.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error('ffmpeg failed: ' + err.slice(-400)))));
  });
}
async function duration(ffprobe, file) {
  const o = await run(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', file]);
  return parseFloat(JSON.parse(o).format.duration) || 0;
}
// small mono mp3 piece (16 kHz is what the speech model uses anyway)
function cutPiece(ffmpeg, file, start, len, out) {
  const a = ['-y', '-ss', String(start)];
  if (len) a.push('-t', String(len));
  a.push('-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out);
  return run(ffmpeg, a);
}
async function groqOne({ key, file, model, language, signal, fetchImpl }) {
  const f = fetchImpl || fetch;
  let last;
  for (let a = 0; a < 3; a++) {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(file)], { type: 'audio/mpeg' }), 'audio.mp3');
    fd.append('model', model);
    fd.append('response_format', 'verbose_json');
    fd.append('timestamp_granularities[]', 'word');
    fd.append('timestamp_granularities[]', 'segment');
    if (language) fd.append('language', language);
    try {
      const r = await f('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      const msg = 'Groq ' + r.status + ': ' + (j.error && j.error.message ? j.error.message : 'request failed');
      if (r.status === 429 || r.status >= 500) { last = new Error(msg); await sleep(2000 * (a + 1)); continue; }
      throw new Error(msg);
    } catch (e) { if (e.name === 'AbortError' || /^Groq 4/.test(e.message)) throw e; last = e; await sleep(1500); }
  }
  throw last || new Error('Groq request failed.');
}
// Pure function (tested): join pieces and shift times by each piece offset.
function mergeParts(parts) {
  const out = { language: '', duration: 0, text: '', segments: [], words: [] };
  for (const p of parts) {
    const j = p.json, off = p.offset;
    if (!out.language && j.language) out.language = j.language;
    for (const s of j.segments || []) out.segments.push({ start: round(+s.start + off), end: round(+s.end + off), text: String(s.text || '').trim() });
    for (const w of j.words || []) {
      const word = String(w.word || '').trim();
      if (word) out.words.push({ start: round(+w.start + off), end: round(+w.end + off), word });
    }
    out.text += (out.text ? ' ' : '') + String(j.text || '').trim();
    out.duration = Math.max(out.duration, round(off + (+j.duration || 0)));
  }
  const lastEnd = Math.max(0, ...out.segments.map((s) => s.end), ...out.words.map((w) => w.end));
  if (!out.duration || out.duration < lastEnd) out.duration = round(lastEnd);
  return out;
}
const round = (x) => Math.round(x * 1000) / 1000;

async function transcribe({ audioPath, key, ffmpeg, ffprobe, model = 'whisper-large-v3', language, onProgress = () => {}, signal, fetchImpl }) {
  if (!key) throw new Error('Groq key is missing. Open Keys and add it.');
  const total = await duration(ffprobe, audioPath);
  if (!total) throw new Error('Could not read the audio length.');
  const pieces = [];
  if (total <= SINGLE_MAX_SEC) pieces.push({ start: 0, len: 0 });
  else for (let s = 0; s < total; s += CHUNK_SEC) pieces.push({ start: s, len: Math.min(CHUNK_SEC, total - s) });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'salmedia-tr-'));
  const parts = [];
  try {
    for (let i = 0; i < pieces.length; i++) {
      if (signal && signal.aborted) throw new Error('cancelled');
      onProgress(`Transcribing (part ${i + 1} of ${pieces.length})`, i / pieces.length);
      const out = path.join(tmp, `p${i}.mp3`);
      await cutPiece(ffmpeg, audioPath, pieces[i].start, pieces[i].len, out);
      const json = await groqOne({ key, file: out, model, language, signal, fetchImpl });
      parts.push({ json: { ...json, duration: pieces[i].len || json.duration || total }, offset: pieces[i].start });
    }
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  const t = mergeParts(parts);
  if (!t.words.length) throw new Error('Groq returned no words. Check that the audio has speech.');
  if (!t.duration || t.duration < total - 2) t.duration = round(total);
  return { version: 1, model, ...t };
}
module.exports = { transcribe, mergeParts };
