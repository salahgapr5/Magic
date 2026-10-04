// OpenAI picks the avatar moments. Then plain code fixes the result so the rules always hold.
const { chatJSON } = require('../openai');

const INTRO_MIN = 20, INTRO_MAX = 30; // intro rule from the spec (ignores max seconds)
const MIN_GAP = 8;   // seconds of B-roll needed between two avatar moments (B-roll items are 8 to 12 s)
const MIN_LEN = 3;   // shortest avatar moment

function buildPrompts(transcript, s) {
  const lines = transcript.segments.map((g) => `[${g.start.toFixed(1)}-${g.end.toFixed(1)}] ${g.text}`).join('\n');
  const system = [
    'You are a video editor. You choose the moments where the speaker appears on camera as an AI avatar. The rest of the video becomes B-roll.',
    'Return JSON only: {"moments":[{"start":0,"end":27.4,"title":"short title"}]}.',
    'Times are seconds and must start and end at sentence borders of the transcript.',
  ].join('\n');
  const user = [
    `Audio length: ${transcript.duration.toFixed(1)} s.`,
    `Rule 1: the FIRST moment is the intro. It starts at 0 and lasts ${INTRO_MIN} to ${INTRO_MAX} seconds (it ignores the max seconds rule). End it at a sentence border.`,
    `Rule 2: choose at most ${Math.max(0, s.maxClips - 1)} more moments after the intro (the intro already counts as one of ${s.maxClips} clips).`,
    `Rule 3: each later moment lasts at most ${s.maxSec} seconds.`,
    `Rule 4: moments must not overlap and need at least ${MIN_GAP + 1} seconds of B-roll between them.`,
    'Rule 5: choose the strongest spoken moments: a key claim, a surprising point, a personal part, the summary or call to action. Spread them over the whole audio.',
    '',
    'Transcript:',
    lines,
  ].join('\n');
  return { system, user };
}

// ---- pure helpers (tested) ----
const nearest = (arr, t) => arr.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), arr[0]);
function normalize(raw, transcript, s) {
  const D = transcript.duration, words = transcript.words;
  const starts = words.map((w) => w.start), ends = words.map((w) => w.end);
  const segEnds = transcript.segments.map((g) => g.end);
  let list = (Array.isArray(raw) ? raw : []).filter((m) => m && typeof m === 'object').map((m) => ({ start: +m.start, end: +m.end, title: String(m.title || '').slice(0, 60) }))
    .filter((m) => Number.isFinite(m.start) && Number.isFinite(m.end) && m.end > m.start).sort((a, b) => a.start - b.start);

  // INTRO: starts at 0, 20..30 s, ignores max seconds
  const lo = Math.min(INTRO_MIN, D), hi = Math.min(INTRO_MAX, D);
  const want = list.length && list[0].start < 3 ? list[0].end : 25;
  let iend;
  const goodSeg = segEnds.filter((e) => e >= lo - 0.01 && e <= hi + 0.01);
  const goodWord = ends.filter((e) => e >= lo - 0.01 && e <= hi + 0.01);
  if (D <= INTRO_MIN) iend = D;
  else if (goodSeg.length) iend = nearest(goodSeg, want);
  else if (goodWord.length) iend = nearest(goodWord, want);
  else iend = Math.min(hi, Math.max(lo, want));
  if (D - iend < MIN_GAP && D <= INTRO_MAX) iend = D;
  const out = [{ id: 'intro', type: 'intro', start: 0, end: round(iend), title: (list[0] && list[0].start < 3 && list[0].title) || 'Intro' }];

  // OTHER moments
  let prevEnd = iend;
  for (const m of list) {
    if (out.length >= s.maxClips) break;
    if (m.start < 3 || m.start < iend + MIN_GAP) continue; // the intro or too close to it
    let st = nearest(starts, Math.min(m.start, D));
    if (st < prevEnd + MIN_GAP) continue;
    const cap = st + s.maxSec;
    let en = Math.min(m.end, cap, D);
    const okEnds = ends.filter((e) => e > st + MIN_LEN && e <= cap + 0.001 && e <= D + 0.001);
    if (!okEnds.length) continue;
    const sentence = segEnds.filter((e) => okEnds.includes(e));
    en = nearest(sentence.length ? sentence : okEnds, en);
    if (en - st < MIN_LEN) continue;
    if (0 < D - en && D - en < MIN_GAP && D - st <= s.maxSec) en = D;
    out.push({ id: '', type: 'avatar', start: round(st), end: round(en), title: m.title || 'Avatar' });
    prevEnd = en;
  }
  out.forEach((m, i) => { m.id = i === 0 ? 'intro' : 'av' + (i + 1); });
  return out;
}
const round = (x) => Math.round(x * 1000) / 1000;

async function detectMoments({ transcript, settings, key, model, signal, fetchImpl }) {
  const { system, user } = buildPrompts(transcript, settings);
  const j = await chatJSON({ key, model, system, user, maxTokens: 4000, signal, fetchImpl });
  const moments = normalize(j.moments, transcript, settings);
  return { version: 1, moments: moments.map(({ id, type, start, end, title }) => ({ id, type, start, end, title })) };
}
module.exports = { detectMoments, normalize, buildPrompts, INTRO_MIN, INTRO_MAX };
