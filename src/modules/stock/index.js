// Stock clips and images. One adapter per site (adapters/). Free sites first build: Pexels, Pixabay.
// To add a paid site later: write one adapter file with the same functions and add it to ADAPTERS. Nothing else changes.
// (Paid rule for later: search + preview while editing, fetch the licensed file only at export.)
const fs = require('fs');
const path = require('path');
const { chatJSON } = require('../openai');
const { download } = require('./download');
const ADAPTERS = { pexels: require('./adapters/pexels'), pixabay: require('./adapters/pixabay') };

const VIDEO_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const srcKey = (s) => (s && s.site ? s.site + ':' + s.id : '');

// Sites to search, in the order from settings, only those that have a key.
function siteOrder(settings, keys) {
  const order = settings && settings.searchOrder === 'pixabay' ? ['pixabay', 'pexels'] : ['pexels', 'pixabay'];
  return order.filter((s) => keys[s]);
}

// ---------- search words (OpenAI) ----------
function cleanWords(arr) {
  const out = [];
  for (const w of Array.isArray(arr) ? arr : typeof arr === 'string' ? [arr] : []) {
    const q = String(w || '').replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
    if (q && !out.includes(q.toLowerCase())) out.push(q.toLowerCase());
  }
  return out.slice(0, 3);
}
function fallbackWords(text) { // used only if OpenAI cannot answer: the longest words of the script
  const ws = String(text || '').split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length > 4).sort((a, b) => b.length - a.length);
  return cleanWords([ws.slice(0, 3).join(' ')]);
}
async function makeSearchWords({ items, key, model, signal, fetchImpl, avoid }) {
  const res = new Map();
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    const system = 'You find stock footage. For each script line write 2 or 3 short English search queries (1 to 4 words each) for a free stock site such as Pexels. Describe what a camera would SEE (people, places, objects, actions), not abstract ideas. First query is the most specific, last is the most general. Return JSON only: {"items":[{"id":"b2","searchWords":["office team meeting","business people talking"]}]}.';
    const user = (avoid ? 'The earlier searches gave nothing new. Use different words from these: ' + avoid.slice(0, 12).join('; ') + '\n\n' : '') + 'Script lines:\n' + chunk.map((c) => `${c.id}: ${String(c.text || '').slice(0, 300)}`).join('\n');
    let raw = [];
    try { raw = (await chatJSON({ key, model, system, user, maxTokens: 3000, signal, fetchImpl })).items; }
    catch (e) { if (e.name === 'AbortError' || /OpenAI 4(01|03|04)/.test(e.message)) throw e; /* other problem: code makes simple words */ }
    const by = new Map((Array.isArray(raw) ? raw : []).map((x) => [x && x.id, x]));
    for (const c of chunk) { const w = cleanWords(by.get(c.id) && by.get(c.id).searchWords); res.set(c.id, w.length ? w : fallbackWords(c.text)); }
  }
  return res;
}

// ---------- find candidates (search only, nothing downloaded) ----------
// ctx: { sites, keys, used:Set, cache:Map, signal, fetchImpl }
async function findCandidates(item, ctx) {
  const need = item.end - item.start, list = [], seen = new Set();
  let short = 0, errors = 0, lastErr = null;
  const tried = new Set(item.tried || []);
  for (const q of item.searchWords || []) {
    for (const site of ctx.sites) {
      const ck = [site, item.kind, q].join('|');
      let found = ctx.cache.get(ck);
      if (!found) {
        try { found = await (item.kind === 'clip' ? ADAPTERS[site].searchVideos : ADAPTERS[site].searchImages)({ query: q, key: ctx.keys[site], signal: ctx.signal, fetchImpl: ctx.fetchImpl }); }
        catch (e) { if (e.fatal || e.name === 'AbortError') throw e; errors++; lastErr = e; continue; }
        ctx.cache.set(ck, found);
      }
      for (const c of found) {
        const k = srcKey(c);
        if (seen.has(k) || ctx.used.has(k) || tried.has(k)) continue;
        seen.add(k);
        if (c.kind === 'clip' && c.duration < need - 0.05) { short++; continue; } // shorter than the slot: not used
        list.push(c);
      }
      if (list.length >= 3) return { list, short, errors };
    }
  }
  if (!list.length && errors && !short) { const e = new Error((lastErr && lastErr.message) || 'Stock search failed.'); e.searchFailed = true; throw e; }
  return { list, short, errors };
}

const extOf = (c) => { if (c.kind === 'clip') return '.mp4'; const m = String(c.url).split('?')[0].match(/\.(jpe?g|png|webp)$/i); return m ? m[0].toLowerCase() : '.jpg'; };

// Download the first candidate that works. verify(file, item, cand) can reject a file (wrong size/length) -> next candidate.
async function fillItem(item, ctx, dir, verify) {
  const found = await findCandidates(item, ctx);
  if (!found.list.length) return { ok: false, reason: found.short ? 'no clip long enough' : 'no match' };
  let lastErr = '';
  for (const c of found.list) {
    const k = srcKey(c); if (ctx.used.has(k)) continue; ctx.used.add(k);
    const rel = 'stock/' + item.id + '-' + c.site + c.id + extOf(c), dest = path.join(dir, rel);
    try {
      await download(await ADAPTERS[c.site].resolve(c), dest, { signal: ctx.signal, fetchImpl: ctx.fetchImpl, accept: c.kind === 'clip' ? /video|mp4/i : /image/i });
      const info = verify ? await verify(dest, item, c) : null;
      return { ok: true, rel, cand: c, info };
    } catch (e) { try { fs.unlinkSync(dest); } catch {} if (e.name === 'AbortError') throw e; lastErr = e.message; ctx.used.delete(k); item.tried = [...(item.tried || []), k].slice(-30); }
  }
  return { ok: false, reason: 'download failed' + (lastErr ? ': ' + lastErr.slice(0, 80) : '') };
}
const newCtx = ({ settings, keys, items, signal, fetchImpl }) => ({
  sites: siteOrder(settings, keys), keys, signal, fetchImpl, cache: new Map(),
  used: new Set(items.filter((i) => i.file && i.source).map((i) => srcKey(i.source))),
});
module.exports = { ADAPTERS, siteOrder, makeSearchWords, cleanWords, fallbackWords, findCandidates, fillItem, newCtx, srcKey, VIDEO_EXT, IMAGE_EXT };
