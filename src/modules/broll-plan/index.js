// B-roll plan: gaps -> items (8 to 12 s each) -> mix (PNG / clip / image) -> random order -> plan.json
const ITEM_MIN = 8, ITEM_MAX = 12;
const round = (x) => Math.round(x * 1000) / 1000;

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Everything not covered by a moment is a gap.
function computeGaps(moments, duration) {
  const gaps = []; let cur = 0;
  for (const m of [...moments].sort((a, b) => a.start - b.start)) {
    if (m.start > cur + 0.05) gaps.push({ start: round(cur), end: round(m.start) });
    cur = Math.max(cur, m.end);
  }
  if (cur < duration - 0.05) gaps.push({ start: round(cur), end: round(duration) });
  return gaps;
}

// One item per idea (8 to 12 s). A gap of 12 to 16 s is split in two short items (never longer than 12 s). Cuts snap to sentence ends, then word ends.
function splitGap(gap, transcript) {
  const len = gap.end - gap.start;
  if (len < ITEM_MIN * 2 - 0.0001 && len <= ITEM_MAX) return [{ start: gap.start, end: gap.end }];
  const nMin = Math.ceil(len / ITEM_MAX), nMax = Math.max(1, Math.floor(len / ITEM_MIN));
  const n = nMin > nMax ? nMin : Math.min(nMax, Math.max(nMin, Math.round(len / 10)));
  const sent = [...transcript.segments.map((g) => g.end), ...transcript.words.filter((w) => /[.!?؟…。]$/.test(w.word)).map((w) => w.end)];
  const wordEnds = transcript.words.map((w) => w.end);
  const inGap = (a) => a.filter((t) => t > gap.start + 0.5 && t < gap.end - 0.5);
  const S = inGap(sent), W = inGap(wordEnds);
  const cuts = [gap.start];
  for (let k = 1; k < n; k++) {
    const ideal = gap.start + (k * len) / n, prev = cuts[cuts.length - 1];
    const left = n - k; // pieces still to place after this cut
    const ok = (t) => t - prev >= ITEM_MIN - 0.001 && t - prev <= ITEM_MAX + 0.001 && gap.end - t >= left * ITEM_MIN - 0.001 && gap.end - t <= left * ITEM_MAX + 0.001;
    const pick = (arr) => arr.filter((t) => Math.abs(t - ideal) <= 2 && ok(t)).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
    cuts.push(round(pick(S) ?? pick(W) ?? ideal));
  }
  cuts.push(gap.end);
  const items = [];
  for (let i = 0; i < cuts.length - 1; i++) items.push({ start: round(cuts[i]), end: round(cuts[i + 1]) });
  return items;
}

// How many of each kind. If "max N stock in a row" cannot hold, extra stock becomes PNG (and we say so).
function planCounts(total, s) {
  let png = Math.round((total * s.pngPct) / 100), stock = total - png, adjusted = 0;
  while (stock > s.maxStockRow * (png + 1)) { stock--; png++; adjusted++; }
  const image = stock ? Math.round(stock / (s.clipImageRatio + 1)) : 0;
  return { png, clip: stock - image, image, adjusted };
}

// Random order, never more than maxRow stock items in a row (always possible, checked at every step).
function orderKinds(c, maxRow, rng) {
  let S = c.clip + c.image, P = c.png, run = 0; const seq = [];
  const feasible = (s, p, r) => s <= (maxRow - r) + maxRow * p;
  const stockKinds = [...Array(c.clip).fill('clip'), ...Array(c.image).fill('image')];
  for (let i = stockKinds.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [stockKinds[i], stockKinds[j]] = [stockKinds[j], stockKinds[i]]; }
  while (S + P > 0) {
    const canS = S > 0 && run < maxRow && feasible(S - 1, P, run + 1);
    const canP = P > 0 && feasible(S, P - 1, 0);
    let pickStock;
    if (canS && canP) pickStock = rng() < S / (S + P); else if (canS) pickStock = true; else if (canP) pickStock = false;
    else throw new Error('Plan order failed (internal error).');
    if (pickStock) { seq.push(stockKinds.pop()); S--; run++; } else { seq.push('png'); P--; run = 0; }
  }
  return seq;
}

function wordsIn(transcript, a, b) {
  return transcript.words.filter((w) => w.start >= a - 0.01 && w.start < b).map((w) => w.word).join(' ');
}
function counts(items) {
  return { png: items.filter((i) => i.kind === 'png').length, clip: items.filter((i) => i.kind === 'clip').length, image: items.filter((i) => i.kind === 'image').length, total: items.length };
}

function buildPlan({ moments, transcript, settings, seed }) {
  const rng = mulberry32(seed == null ? (Date.now() & 0xffffffff) : seed);
  const slots = [];
  for (const g of computeGaps(moments, transcript.duration)) for (const it of splitGap(g, transcript)) slots.push(it);
  const c = planCounts(slots.length, settings);
  const kinds = orderKinds(c, settings.maxStockRow, rng);
  const items = slots.map((sl, i) => {
    const id = 'b' + (i + 1), kind = kinds[i], text = wordsIn(transcript, sl.start, sl.end);
    return kind === 'png' ? { id, start: sl.start, end: sl.end, kind, slide: null, text, overlay: false } : { id, start: sl.start, end: sl.end, kind, file: null, text, overlay: false };
  });
  return { version: 1, items, counts: counts(items), adjusted: c.adjusted };
}
module.exports = { buildPlan, computeGaps, splitGap, planCounts, orderKinds, counts, mulberry32, ITEM_MIN, ITEM_MAX };
