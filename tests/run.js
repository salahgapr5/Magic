// Offline tests. No network, no Electron window. Run: node tests/run.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).toString().split('\n').slice(0, 3).join('\n       ')); } };

// fake electron so keystore/pipeline load outside Electron
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'electron') return { app: { getPath: () => os.tmpdir(), isPackaged: false, setPath() {} }, safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: class {} };
  if (req === 'ffmpeg-static') return '/usr/bin/ffmpeg';
  if (req === 'ffprobe-static') return { path: '/usr/bin/ffprobe' };
  return origLoad.call(this, req, ...a);
};
const S = path.join(__dirname, '..', 'src');
const { buildPlan, splitGap, planCounts, orderKinds, computeGaps, mulberry32 } = require(S + '/modules/broll-plan');
const { normalize, detectMoments } = require(S + '/modules/moments');
const { mergeParts, transcribe } = require(S + '/modules/transcribe');
const { check, STYLES, LAYOUTS } = require(S + '/modules/slides/pick');

function fakeTranscript(D, sentSec = 5) {
  const words = [], segments = []; let t0 = 0, n = 0;
  while (t0 < D - 0.3) {
    const segStart = t0, cnt = Math.round(sentSec / 0.4);
    for (let i = 0; i < cnt && t0 < D - 0.3; i++) { const last = i === cnt - 1; words.push({ start: +t0.toFixed(3), end: +(t0 + 0.35).toFixed(3), word: 'w' + (n++) + (last ? '.' : '') }); t0 += 0.4; }
    segments.push({ start: segStart, end: +words[words.length - 1].end.toFixed(3), text: 'sentence' });
  }
  return { version: 1, duration: D, language: 'en', text: '', segments, words };
}
const S0 = { maxClips: 4, maxSec: 15, pngPct: 70, clipImageRatio: 4, maxStockRow: 3, searchOrder: 'pexels' };

(async () => {
  console.log('broll-plan');
  await t('gaps = everything not covered by moments', () => {
    const g = computeGaps([{ start: 0, end: 27.4 }, { start: 95, end: 108.5 }], 200);
    assert.deepStrictEqual(g, [{ start: 27.4, end: 95 }, { start: 108.5, end: 200 }]);
  });
  await t('every B-roll item is 8 to 12 s and items tile each gap exactly (5000 random gaps)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 5000; i++) {
      const len = Math.round((8 + r() * 200) * 1000) / 1000, st = Math.round(r() * 50000) / 1000, tr = fakeTranscript(st + len + 5, 2 + r() * 8);
      const items = splitGap({ start: st, end: st + len }, tr);
      assert.ok(Math.abs(items[0].start - st) < 1e-6 && Math.abs(items.at(-1).end - (st + len)) < 1e-6, 'tile ends');
      items.forEach((it, k) => { const l = it.end - it.start; assert.ok(l <= 12.001, `too long ${l} gap ${len}`); assert.ok(l >= (len > 12 && len < 16 ? 6 : 7.999), `too short ${l} gap ${len}`); if (k) assert.ok(Math.abs(it.start - items[k - 1].end) < 1e-6, 'contiguous'); });
    }
  });
  await t('gap of 13 s = two items of 6.5 s (never one item longer than 12 s)', () => {
    const it = splitGap({ start: 10, end: 23 }, fakeTranscript(60)); assert.strictEqual(it.length, 2); assert.ok(it.every((x) => x.end - x.start <= 12.001));
  });
  await t('gap shorter than 8 s still gives one item', () => {
    const it = splitGap({ start: 10, end: 15.5 }, fakeTranscript(30)); assert.strictEqual(it.length, 1);
  });
  await t('max N stock in a row always holds (3000 random cases, N from 1 to 6)', () => {
    const r = mulberry32(3);
    for (let i = 0; i < 3000; i++) {
      const total = 1 + Math.floor(r() * 80), s = { pngPct: Math.floor(r() * 101), clipImageRatio: 0.5 + r() * 8, maxStockRow: 1 + Math.floor(r() * 6) };
      const c = planCounts(total, s); assert.strictEqual(c.png + c.clip + c.image, total);
      const seq = orderKinds(c, s.maxStockRow, mulberry32(i)); assert.strictEqual(seq.length, total);
      let run = 0; for (const k of seq) { run = k === 'png' ? 0 : run + 1; assert.ok(run <= s.maxStockRow, 'run ' + run + ' > ' + s.maxStockRow); }
      assert.strictEqual(seq.filter((k) => k === 'png').length, c.png); assert.strictEqual(seq.filter((k) => k === 'image').length, c.image);
    }
  });
  await t('default 70/30 and 1 image per 4 clips', () => {
    const c = planCounts(100, S0); assert.deepStrictEqual([c.png, c.clip, c.image, c.adjusted], [70, 24, 6, 0]);
    const d = planCounts(50, S0); assert.strictEqual(d.png, 35); assert.strictEqual(d.clip + d.image, 15); assert.strictEqual(d.image, 3);
  });
  await t('if the row rule cannot hold, stock turns into PNG and it is reported', () => {
    const c = planCounts(20, { pngPct: 0, clipImageRatio: 4, maxStockRow: 3 }); assert.ok(c.adjusted > 0); assert.ok(c.clip + c.image <= 3 * (c.png + 1));
  });
  await t('order is random (different seeds give different orders)', () => {
    const c = planCounts(40, S0), a = orderKinds(c, 3, mulberry32(1)).join(), b = orderKinds(c, 3, mulberry32(2)).join(); assert.notStrictEqual(a, b);
  });
  await t('buildPlan matches contract (png has slide, stock has file:null, ids b1.., sorted, no overlap with avatar)', () => {
    const tr = fakeTranscript(300), moments = [{ id: 'intro', type: 'intro', start: 0, end: 27.4 }, { id: 'av2', type: 'avatar', start: 95, end: 108.5 }];
    const p = buildPlan({ moments, transcript: tr, settings: S0, seed: 5 });
    assert.strictEqual(p.version, 1); assert.strictEqual(p.counts.total, p.items.length);
    p.items.forEach((it, i) => { assert.strictEqual(it.id, 'b' + (i + 1)); if (it.kind === 'png') assert.ok('slide' in it); else { assert.strictEqual(it.file, null); assert.ok(['clip', 'image'].includes(it.kind)); } assert.strictEqual(it.overlay, false); assert.ok(it.end - it.start >= 6.4 && it.end - it.start <= 12.001); if (i) assert.ok(it.start >= p.items[i - 1].end - 1e-6); assert.ok(!(it.start < 108.5 && it.end > 95) || it.end <= 95 + 1e-6 || it.start >= 108.5 - 1e-6); });
    assert.ok(Math.abs(p.counts.png / p.counts.total - 0.7) < 0.1, 'about 70%');
  });

  console.log('moments');
  await t('intro is 20 to 30 s, starts at 0, ignores max seconds (maxSec 5)', () => {
    const tr = fakeTranscript(200); const m = normalize([{ start: 0, end: 12, title: 'x' }], tr, { ...S0, maxSec: 5 });
    assert.strictEqual(m[0].id, 'intro'); assert.strictEqual(m[0].start, 0); assert.ok(m[0].end >= 20 && m[0].end <= 30, 'intro end ' + m[0].end);
  });
  await t('later moments obey max seconds, max count, no overlap, gap, ids', () => {
    const tr = fakeTranscript(300);
    const raw = [{ start: 0, end: 26 }, { start: 40, end: 80 }, { start: 85, end: 90 }, { start: 120, end: 140 }, { start: 200, end: 212 }, { start: 250, end: 260 }];
    const m = normalize(raw, tr, { ...S0, maxClips: 4, maxSec: 15 });
    assert.ok(m.length <= 4); assert.deepStrictEqual(m.map((x) => x.id), ['intro', 'av2', 'av3', 'av4'].slice(0, m.length));
    m.forEach((x, i) => { if (i) { assert.ok(x.end - x.start <= 15.001, 'dur'); assert.ok(x.start >= m[i - 1].end + 8 - 1e-6, 'gap'); } });
  });
  await t('garbage from OpenAI still gives a valid intro', () => {
    const tr = fakeTranscript(100); const m = normalize([{ foo: 1 }, null, { start: 'a', end: 'b' }], tr, S0);
    assert.strictEqual(m.length, 1); assert.ok(m[0].end >= 20 && m[0].end <= 30);
  });
  await t('very short audio (12 s) = intro covers it all', () => {
    const m = normalize([], fakeTranscript(12), S0); assert.strictEqual(m[0].end, 12);
  });
  await t('maxClips 1 = intro only', () => {
    assert.strictEqual(normalize([{ start: 0, end: 25 }, { start: 60, end: 70 }], fakeTranscript(200), { ...S0, maxClips: 1 }).length, 1);
  });
  await t('detectMoments sends the rules to OpenAI and returns moments.json format', async () => {
    let sent; const fetchImpl = async (u, o) => { sent = JSON.parse(o.body); return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ moments: [{ start: 0, end: 26, title: 'Hello' }, { start: 60, end: 70, title: 'Key' }] }) } }] }) }; };
    const r = await detectMoments({ transcript: fakeTranscript(200), settings: S0, key: 'k', model: 'm', fetchImpl });
    assert.ok(/20 to 30/.test(sent.messages[1].content) && /at most 15/.test(sent.messages[1].content)); assert.strictEqual(sent.model, 'm');
    assert.strictEqual(r.version, 1); assert.ok(r.moments.every((x) => ['id', 'type', 'start', 'end'].every((k) => k in x)));
  });

  console.log('slides pick');
  await t('style/layout answer is checked (bad values replaced, no same layout twice in a row)', () => {
    const items = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }];
    const r = check([{ id: 'b1', style: 'clay', layout: 'chain' }, { id: 'b2', style: 'nope', layout: 'chain' }, { id: 'b3', style: 'ocean', layout: 'zzz' }], items, mulberry32(1));
    assert.ok(r.every((x) => STYLES.includes(x.style))); assert.strictEqual(r[1].layout, ''); assert.strictEqual(r[2].layout, '');
  });

  console.log('transcribe');
  await t('mergeParts shifts times by the piece offset and keeps duration', () => {
    const m = mergeParts([{ offset: 0, json: { language: 'ar', text: 'a', duration: 600, segments: [{ start: 0, end: 5, text: 'a' }], words: [{ start: 0, end: 1, word: ' a ' }] } }, { offset: 600, json: { text: 'b', duration: 100, segments: [{ start: 1, end: 4, text: 'b' }], words: [{ start: 1, end: 2, word: 'b' }] } }]);
    assert.strictEqual(m.words[1].start, 601); assert.strictEqual(m.words[0].word, 'a'); assert.strictEqual(m.duration, 700); assert.strictEqual(m.language, 'ar');
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  const tone = (sec, f) => { const r = spawnSync('/usr/bin/ffmpeg', ['-y', '-f', 'lavfi', '-i', `sine=frequency=300:duration=${sec}`, '-ac', '1', '-ar', '22050', '-b:a', '32k', f]); assert.strictEqual(r.status, 0); };
  await t('short audio = one Groq call; word timestamps asked; transcript.json shape', async () => {
    const f = path.join(tmp, 'a.mp3'); tone(30, f); let calls = 0, fields;
    const fetchImpl = async (u, o) => { calls++; fields = [...o.body.keys()]; return { ok: true, json: async () => ({ language: 'en', text: 'hi', duration: 30, segments: [{ start: 0, end: 3, text: 'hi' }], words: [{ start: 0, end: 1, word: 'hi' }] }) }; };
    const r = await transcribe({ audioPath: f, key: 'k', ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe', fetchImpl });
    assert.strictEqual(calls, 1); assert.ok(fields.includes('timestamp_granularities[]')); assert.strictEqual(r.version, 1); assert.ok(r.words.length && r.segments.length && r.duration >= 29);
  });
  await t('long audio (25 min) is cut in 10 min pieces and times are shifted', async () => {
    const f = path.join(tmp, 'long.mp3'); tone(1500, f); let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ language: 'en', text: 'x', segments: [{ start: 1, end: 2, text: 'x' }], words: [{ start: 1, end: 2, word: 'x' }] }) }; };
    const r = await transcribe({ audioPath: f, key: 'k', ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe', fetchImpl });
    assert.strictEqual(calls, 3); assert.deepStrictEqual(r.words.map((w) => w.start), [1, 601, 1201]); assert.ok(Math.abs(r.duration - 1500) < 3);
  });
  await t('Groq 401 stops at once with a clear message; missing key is caught', async () => {
    const f = path.join(tmp, 'a.mp3'); let calls = 0;
    await assert.rejects(transcribe({ audioPath: f, key: 'bad', ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe', fetchImpl: async () => { calls++; return { ok: false, status: 401, json: async () => ({ error: { message: 'Invalid API Key' } }) }; } }), /Groq 401: Invalid API Key/);
    assert.strictEqual(calls, 1);
    await assert.rejects(transcribe({ audioPath: f, key: '', ffmpeg: '', ffprobe: '' }), /Groq key is missing/);
  });

  console.log('stock: adapters, download, search');
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const pexels = require(S + '/modules/stock/adapters/pexels'), pixabay = require(S + '/modules/stock/adapters/pixabay'), stockMod = require(S + '/modules/stock'), { download } = require(S + '/modules/stock/download');
  await t('Pexels clips: only mp4, 16:9, 1080p or bigger; picks the smallest file that qualifies', async () => {
    const f = async () => J({ videos: [
      { id: 1, duration: 20, image: 'p.jpg', url: 'u1', video_files: [{ file_type: 'video/mp4', link: 'L720', width: 1280, height: 720 }, { file_type: 'video/mp4', link: 'L4K', width: 3840, height: 2160 }, { file_type: 'video/mp4', link: 'L1080', width: 1920, height: 1080 }] },
      { id: 2, duration: 9, video_files: [{ file_type: 'video/mp4', link: 'a', width: 1280, height: 720 }] },
      { id: 3, duration: 9, video_files: [{ file_type: 'video/mp4', link: 'b', width: 1080, height: 1920 }] },
      { id: 4, duration: 9, video_files: [{ file_type: 'video/webm', link: 'c', width: 1920, height: 1080 }] }] });
    const r = await pexels.searchVideos({ query: 'x', key: 'k', fetchImpl: f }); assert.strictEqual(r.length, 1); assert.strictEqual(r[0].url, 'L1080'); assert.strictEqual(r[0].duration, 20);
  });
  await t('Pixabay clips and images are filtered the same way', async () => {
    const v = await pixabay.searchVideos({ query: 'x', key: 'k', fetchImpl: async () => J({ hits: [{ id: 1, duration: 12, videos: { large: { url: '', width: 1920, height: 1080 }, medium: { url: 'm', width: 1280, height: 720 } } }, { id: 2, duration: 14, videos: { large: { url: 'L', width: 1920, height: 1080 }, tiny: { url: 't' } } }] }) });
    assert.deepStrictEqual(v.map((x) => x.id), ['2']);
    const im = await pixabay.searchImages({ query: 'x', key: 'k', fetchImpl: async () => J({ hits: [{ id: 5, imageWidth: 800, imageHeight: 600, largeImageURL: 'a' }, { id: 6, imageWidth: 4000, imageHeight: 2250, largeImageURL: 'b' }] }) });
    assert.deepStrictEqual(im.map((x) => x.id), ['6']);
  });
  await t('Wrong key (401) is a fatal, clear message; rate limit (429) is not fatal', async () => {
    await assert.rejects(pexels.searchVideos({ query: 'x', key: 'bad', fetchImpl: async () => J({}, 401) }), (e) => e.fatal && /Pexels 401: key rejected/.test(e.message));
    await assert.rejects(pixabay.searchImages({ query: 'x', key: 'k', fetchImpl: async () => J({}, 429) }), (e) => !e.fatal && /too many requests/.test(e.message));
  });
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-dl-'));
  const body = (n) => Buffer.alloc(n, 7), H = (o) => ({ 'content-type': 'video/mp4', ...o });
  await t('download follows redirects and writes the file', async () => {
    const seen = []; const f = async (u) => { seen.push(u); return u.endsWith('/a') ? new Response(null, { status: 302, headers: { location: 'https://cdn.x/b' } }) : new Response(body(5000), { status: 200, headers: H({ 'content-length': '5000' }) }); };
    const r = await download('https://x.com/a', path.join(dl, 'o.mp4'), { fetchImpl: f }); assert.strictEqual(r.bytes, 5000); assert.deepStrictEqual(seen, ['https://x.com/a', 'https://cdn.x/b']); assert.ok(!fs.existsSync(path.join(dl, 'o.mp4.part')));
  });
  await t('download: 404, web page, cut-off file and redirect loop all fail and leave no file behind', async () => {
    const cases = [[async () => new Response('no', { status: 404 }), /HTTP 404/], [async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), /web page/],
      [async () => new Response(body(5000), { status: 200, headers: H({ 'content-length': '9000' }) }), /cut off/], [async () => new Response(null, { status: 302, headers: { location: 'https://x.com/a' } }), /Too many redirects/]];
    for (const [f, re] of cases) { const d = path.join(dl, 'bad.mp4'); await assert.rejects(download('https://x.com/a', d, { fetchImpl: f }), re); assert.ok(!fs.existsSync(d) && !fs.existsSync(d + '.part'), 'no leftover'); }
  });
  await t('search words: OpenAI answer is cleaned; if OpenAI gives junk, simple words come from the script', async () => {
    const good = await stockMod.makeSearchWords({ items: [{ id: 'b1', text: 'x' }], key: 'k', model: 'm', fetchImpl: async () => J({ choices: [{ message: { content: JSON.stringify({ items: [{ id: 'b1', searchWords: ['City  Street!!', 'a b c d e f g', 'city street'] }] }) } }] }) });
    assert.deepStrictEqual(good.get('b1'), ['city street', 'a b c d e']);
    const junk = await stockMod.makeSearchWords({ items: [{ id: 'b1', text: 'customers abandon shopping carts' }], key: 'k', model: 'm', fetchImpl: async () => J({ choices: [{ message: { content: 'not json' } }] }) });
    assert.ok(junk.get('b1').length === 1 && /shopping/.test(junk.get('b1')[0]));
    await assert.rejects(stockMod.makeSearchWords({ items: [{ id: 'b1', text: 'x' }], key: 'k', model: 'm', fetchImpl: async () => J({ error: { message: 'model not found' } }, 404) }), /OpenAI 404/);
  });
  await t('search skips clips shorter than the slot and sources already used; network failure is not "no match"', async () => {
    const mk = (id, d) => ({ id, duration: d, image: '', url: 'u', video_files: [{ file_type: 'video/mp4', link: 'L' + id, width: 1920, height: 1080 }] });
    const f = async () => J({ videos: [mk(1, 20), mk(2, 5), mk(3, 30)] });
    const item = { id: 'b1', kind: 'clip', start: 0, end: 10, searchWords: ['q'] };
    const ctx = stockMod.newCtx({ settings: S0, keys: { pexels: 'k' }, items: [{ file: 'x', source: { site: 'pexels', id: '3' } }], fetchImpl: f });
    const r = await stockMod.findCandidates(item, ctx); assert.deepStrictEqual(r.list.map((x) => x.id), ['1']); assert.strictEqual(r.short, 1);
    const ctx2 = stockMod.newCtx({ settings: S0, keys: { pexels: 'k' }, items: [], fetchImpl: async () => { throw new Error('offline'); } });
    await assert.rejects(stockMod.findCandidates(item, ctx2), (e) => e.searchFailed);
  });
  await t('search order setting: Pixabay first only when chosen and only sites that have a key', () => {
    assert.deepStrictEqual(stockMod.siteOrder({ searchOrder: 'pixabay' }, { pexels: 'a', pixabay: 'b' }), ['pixabay', 'pexels']);
    assert.deepStrictEqual(stockMod.siteOrder({ searchOrder: 'pexels' }, { pexels: 'a', pixabay: 'b' }), ['pexels', 'pixabay']);
    assert.deepStrictEqual(stockMod.siteOrder({ searchOrder: 'pexels' }, { pixabay: 'b' }), ['pixabay']);
    assert.strictEqual(require(S + '/modules/project').cleanSettings({ searchOrder: 'zzz' }).searchOrder, 'pexels');
  });

  console.log('whole pipeline (fake Groq/OpenAI/Pexels/Pixabay, fake slide window, real ffmpeg)');
  const KEYS = { openai: 'ok', groq: 'gk', openai_model: 'gpt-4.1-mini', pexels: 'pk', pixabay: '' };
  const keystore = require(S + '/keystore'); keystore.getKey = (n) => KEYS[n] || '';
  const { SlideEngine } = require(S + '/modules/slides');
  let renders = 0;
  SlideEngine.prototype.render = async function (item, opts) { renders++; if (item.text.includes('FAILME') && renders < 3) throw new Error('boom'); fs.mkdirSync(path.join(opts.dir, 'slides'), { recursive: true }); const rel = 'slides/' + item.id + '.png'; spawnSync('/usr/bin/ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080', '-frames:v', '1', path.join(opts.dir, rel)]); return { slide: rel, layout: 'chain', style: opts.style }; };
  const pipe = require(S + '/pipeline'); const proj = require(S + '/modules/project');
  const D = 150, tr = fakeTranscript(D);
  const ff = (...a) => { const r = spawnSync('/usr/bin/ffmpeg', ['-y', ...a]); assert.strictEqual(r.status, 0, String(r.stderr).slice(-200)); };
  const media = (name, sec) => { const f = path.join(tmp, name); ff('-f', 'lavfi', '-i', `color=c=teal:s=1920x1080:r=5:d=${sec}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45', '-pix_fmt', 'yuv420p', f); return fs.readFileSync(f); };
  const MP4 = media('stock14.mp4', 36); const JPG = (() => { const f = path.join(tmp, 's.jpg'); ff('-f', 'lavfi', '-i', 'color=c=orange:s=1920x1080', '-frames:v', '1', f); return fs.readFileSync(f); })();
  const mode = { noMatch: false, netfail: false, auth401: false, only: null, log: [], models: [], groq: 0 };
  const PEX_V = [101, 102, 103, 104, 105, 106, 107, 108].map((id) => ({ id, duration: 40, image: '', url: 'https://pexels.test/v' + id, video_files: [{ file_type: 'video/mp4', link: 'https://videos.pexels.com/redirect/' + id + '.mp4', width: 1280, height: 720 }, { file_type: 'video/mp4', link: 'https://videos.pexels.com/redirect/' + id + '.mp4', width: 1920, height: 1080 }] }))
    .concat([{ id: 109, duration: 3, video_files: [{ file_type: 'video/mp4', link: 'https://videos.pexels.com/redirect/109.mp4', width: 1920, height: 1080 }] }]);
  const PEX_P = [201, 202, 203, 204].map((id) => ({ id, width: 4000, height: 2250, url: 'u', src: { original: 'https://images.pexels.com/p/' + id + '.jpg', medium: 'm' } }));
  global.fetch = async (url, o = {}) => {
    url = String(url); mode.log.push(url);
    if (/groq/.test(url)) { mode.groq++; return J({ language: 'en', text: 'x', duration: D, segments: tr.segments, words: tr.words }); }
    if (/api\.openai\.com/.test(url)) {
      const b = JSON.parse(o.body); mode.models.push(b.model); const sys = b.messages[0].content, usr = b.messages[1].content; let content;
      if (/video editor/.test(sys)) content = { moments: [{ start: 0, end: 26, title: 'Intro' }, { start: 60, end: 72, title: 'Middle' }, { start: 110, end: 120, title: 'End' }] };
      else if (/stock footage/.test(sys)) content = { items: [...usr.matchAll(/^(b\d+):/gm)].map((m) => ({ id: m[1], searchWords: ['busy city street', 'people walking'] })) };
      else content = { items: [] };
      return J({ choices: [{ message: { content: JSON.stringify(content) } }] });
    }
    if (/api\.pexels\.com/.test(url)) {
      if (mode.netfail) throw new Error('offline'); if (mode.auth401) return J({ error: 'no' }, 401);
      if (mode.noMatch) return J({ videos: [], photos: [] });
      if (/videos\/search/.test(url)) return J({ videos: mode.only ? PEX_V.filter((v) => v.id === mode.only) : PEX_V });
      return J({ photos: PEX_P });
    }
    if (/pixabay\.com\/api\/videos/.test(url)) return J({ hits: [{ id: 9001, duration: 40, pageURL: 'pp', videos: { large: { url: 'https://cdn.pixabay.test/9001.mp4', width: 1920, height: 1080 } } }, { id: 9002, duration: 40, videos: { large: { url: 'https://cdn.pixabay.test/9002.mp4', width: 1920, height: 1080 } } }, { id: 9003, duration: 40, videos: { large: { url: 'https://cdn.pixabay.test/9003.mp4', width: 1920, height: 1080 } } }, { id: 9004, duration: 40, videos: { large: { url: 'https://cdn.pixabay.test/9004.mp4', width: 1920, height: 1080 } } }] });
    if (/pixabay\.com\/api\//.test(url)) return J({ hits: [{ id: 9101, imageWidth: 4000, imageHeight: 2250, largeImageURL: 'https://cdn.pixabay.test/9101.jpg' }, { id: 9102, imageWidth: 4000, imageHeight: 2250, largeImageURL: 'https://cdn.pixabay.test/9102.jpg' }] });
    if (/videos\.pexels\.com\/redirect/.test(url)) return new Response(null, { status: 302, headers: { location: 'https://cdn.pexels.test/' + url.split('/').pop() } }); // real redirect hop
    if (/\.mp4$/.test(url)) return new Response(MP4, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(MP4.length) } });
    if (/\.jpg$/.test(url)) return new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(JPG.length) } });
    throw new Error('unexpected url ' + url);
  };
  const dir = path.join(tmp, 'project'); const audioSrc = path.join(tmp, 'voice.mp3'); tone(D, audioSrc); const faceSrc = path.join(tmp, 'face.jpg'); spawnSync('/usr/bin/ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=200x200', '-frames:v', '1', faceSrc]);
  const events = []; pipe.setEmitter((e) => events.push(e));
  const planFile = (d) => JSON.parse(fs.readFileSync(path.join(d || dir, 'plan.json')));
  const slotLen = (i) => i.end - i.start;
  await t('Run all: transcript, moments, plan, stock files in stock/, PNG files in slides/; items 8 to 12 s', async () => {
    pipe.openDir(dir); pipe.setInput('audio', audioSrc); pipe.setInput('face', faceSrc);
    const v = await pipe.runStep('all');
    for (const f of ['transcript.json', 'moments.json', 'plan.json', 'audio.mp3', 'face.jpg', 'settings.json']) assert.ok(fs.existsSync(path.join(dir, f)), f);
    const plan = planFile(), mom = JSON.parse(fs.readFileSync(path.join(dir, 'moments.json')));
    assert.ok(mom.moments.length === 3 && mom.moments[0].id === 'intro');
    const pngs = plan.items.filter((i) => i.kind === 'png'), stocks = plan.items.filter((i) => i.kind !== 'png'); assert.ok(pngs.length > 0 && stocks.length > 0);
    pngs.forEach((i) => assert.ok(i.slide && fs.existsSync(path.join(dir, i.slide)), 'png file ' + i.id));
    stocks.forEach((i) => { assert.ok(i.file && i.file.startsWith('stock/') && fs.existsSync(path.join(dir, i.file)), 'stock file ' + i.id); assert.ok(i.searchWords.length >= 1); assert.strictEqual(i.overlay, false); assert.ok(i.source.site === 'pexels'); });
    assert.strictEqual(new Set(stocks.map((i) => i.source.id)).size, stocks.length, 'no clip used twice');
    plan.items.forEach((i) => assert.ok(slotLen(i) >= 6.4 && slotLen(i) <= 12.001, 'item length ' + slotLen(i)));
    assert.strictEqual(plan.counts.png + plan.counts.clip + plan.counts.image, plan.counts.total); assert.strictEqual(plan.fallback, 0);
    assert.ok(events.some((e) => e.step === 'stock') && events.some((e) => e.step === 'slides')); assert.ok(v.plan.items.length >= 8);
    assert.ok(mode.log.some((u) => /redirect/.test(u)) && mode.log.some((u) => /cdn\.pexels\.test/.test(u)), 'redirect followed');
    assert.ok(!fs.readdirSync(path.join(dir, 'stock')).some((f) => f.endsWith('.part')));
  });
  await t('only gpt-5.6-sol is sent to OpenAI (an old saved model is ignored)', () => {
    assert.ok(mode.models.length >= 3 && mode.models.every((m) => m === 'gpt-5.6-sol'), [...new Set(mode.models)].join());
  });
  await t('Regenerate / Replace / Delete on PNG items', async () => {
    const plan0 = pipe.view().plan, it = plan0.items.find((i) => i.kind === 'png'); const before = renders;
    await pipe.regenerate(it.id); assert.strictEqual(renders, before + 1);
    const img = path.join(tmp, 'mine.jpg'); spawnSync('/usr/bin/ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=640x480', '-frames:v', '1', img]);
    await pipe.replace(it.id, img);
    const size = spawnSync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path.join(dir, it.slide || 'slides/' + it.id + '.png')]).stdout.toString().trim(); assert.strictEqual(size, '1920,1080');
    await assert.rejects(pipe.replace(it.id, path.join(tmp, 'stock14.mp4')), /only be replaced with an image/);
    const n = pipe.view().plan.items.length;
    const r = pipe.remove(it.id); assert.strictEqual(r.plan.items.length, n - 1); assert.ok(!fs.existsSync(path.join(dir, 'slides', it.id + '.png'))); assert.strictEqual(r.plan.counts.total, n - 1);
    const mom = pipe.view().moments.moments;
    r.plan.items.forEach((x, k) => { if (k) { const gapStart = r.plan.items[k - 1].end; if (Math.abs(x.start - gapStart) > 0.02) assert.ok(mom.some((m) => Math.abs(m.start - gapStart) < 0.02 && Math.abs(m.end - x.start) < 0.02), 'hole before ' + x.id); } });
  });
  await t('Regenerate on a stock clip finds another clip, deletes the old file, keeps the slot', async () => {
    const it = pipe.view().plan.items.find((i) => i.kind === 'clip'), oldFile = it.file, oldId = it.source.id, st = it.start, en = it.end;
    await pipe.regenerate(it.id); const n = pipe.view().plan.items.find((x) => x.id === it.id);
    assert.notStrictEqual(n.source.id, oldId); assert.ok(fs.existsSync(path.join(dir, n.file))); assert.ok(!fs.existsSync(path.join(dir, oldFile))); assert.deepStrictEqual([n.start, n.end], [st, en]);
    assert.ok(planFile().items.find((x) => x.id === it.id).tried.includes('pexels:' + oldId));
  });
  await t('Regenerate on a stock image finds another image', async () => {
    const it = pipe.view().plan.items.find((i) => i.kind === 'image'); if (!it) return; const oldId = it.source.id;
    await pipe.regenerate(it.id); assert.notStrictEqual(pipe.view().plan.items.find((x) => x.id === it.id).source.id, oldId);
  });
  await t('Regenerate with nothing else to find: clear message, old file is kept', async () => {
    const it = pipe.view().plan.items.find((i) => i.kind === 'clip'); mode.only = Number(it.source.id); const f = it.file;
    await assert.rejects(pipe.regenerate(it.id), /No other clip found.*old one is kept/); mode.only = null;
    assert.ok(fs.existsSync(path.join(dir, f))); assert.strictEqual(pipe.view().plan.items.find((x) => x.id === it.id).file, f);
  });
  await t('Replace a stock slot with my own video (must be long enough) or image', async () => {
    const it = pipe.view().plan.items.find((i) => i.kind === 'clip'), short = path.join(tmp, 'short.mp4'); ff('-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=5:d=2', '-c:v', 'libx264', '-preset', 'ultrafast', short);
    await assert.rejects(pipe.replace(it.id, short), /slot needs/);
    const long = path.join(tmp, 'long.mp4'); ff('-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=5:d=30', '-c:v', 'libx264', '-preset', 'ultrafast', long);
    const old = it.file; await pipe.replace(it.id, long); let n = pipe.view().plan.items.find((x) => x.id === it.id);
    assert.strictEqual(n.kind, 'clip'); assert.strictEqual(n.source.site, 'mine'); assert.ok(fs.existsSync(path.join(dir, n.file))); assert.ok(!fs.existsSync(path.join(dir, old)));
    await pipe.replace(it.id, path.join(tmp, 's.jpg')); n = pipe.view().plan.items.find((x) => x.id === it.id); assert.strictEqual(n.kind, 'image'); assert.ok(/\.jpg$/.test(n.file) && fs.existsSync(path.join(dir, n.file)));
    await assert.rejects(pipe.replace(it.id, audioSrc), /Choose a video/);
    assert.strictEqual(planFile().counts.image, planFile().items.filter((x) => x.kind === 'image').length);
  });
  await t('Delete a stock item removes its file; the neighbour takes the time; counts follow', async () => {
    const it = pipe.view().plan.items.find((i) => i.kind !== 'png'), f = it.file, n = pipe.view().plan.items.length;
    const r = pipe.remove(it.id); assert.ok(!fs.existsSync(path.join(dir, f))); assert.strictEqual(r.plan.items.length, n - 1); assert.strictEqual(r.plan.counts.total, n - 1);
  });
  await t('Delete gives the time to a PNG/image neighbour first; a too-short clip neighbour is flagged', async () => {
    const items = pipe.view().plan.items; let k = -1;
    for (let i = 1; i < items.length - 1; i++) if (Math.abs(items[i - 1].end - items[i].start) < 0.02 && Math.abs(items[i].end - items[i + 1].start) < 0.02) { k = i; break; }
    assert.ok(k > 0, 'need three items in a row'); const a = items[k - 1], b = items[k], c = items[k + 1];
    a.kind = 'clip'; a.file = null; delete a.tooShort; a.fileDuration = slotLen(a); c.kind = 'png'; c.slide = null; const cStart = c.start, bEnd = b.end;
    pipe.remove(b.id); assert.strictEqual(a.end, a.start + slotLen(a)); assert.strictEqual(c.start, b.start); assert.ok(!a.tooShort);
    // both neighbours are short clips: still no hole, and the clip is flagged
    const items2 = pipe.view().plan.items; let j = -1; for (let i = 1; i < items2.length - 1; i++) if (Math.abs(items2[i - 1].end - items2[i].start) < 0.02 && Math.abs(items2[i].end - items2[i + 1].start) < 0.02) { j = i; break; }
    if (j > 0) { const [x, y, z] = [items2[j - 1], items2[j], items2[j + 1]]; x.kind = 'clip'; x.fileDuration = slotLen(x); z.kind = 'clip'; z.fileDuration = slotLen(z); const r = pipe.remove(y.id); assert.ok(x.tooShort === true); assert.ok(/shorter than its slot/.test(r.note)); }
  });
  await t('Overlay: needs the clip first; per B-roll item only; avatar moments cannot get it; all on/off', async () => {
    const it = pipe.view().plan.items[0];
    assert.throws(() => pipe.setOverlay(it.id, true), /Choose the overlay clip first/);
    await assert.rejects(pipe.setOverlayClip(audioSrc), /must be a video/);
    const ov = path.join(tmp, 'ov.mp4'); ff('-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=5:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', ov);
    const v = await pipe.setOverlayClip(ov); assert.strictEqual(v.project.overlay, 'overlay.mp4'); assert.ok(fs.existsSync(path.join(dir, 'overlay.mp4')));
    assert.ok(planFile().items.every((i) => i.overlay === false), 'OFF by default');
    pipe.setOverlay(it.id, true); assert.strictEqual(planFile().items[0].overlay, true); assert.strictEqual(planFile().items.filter((i) => i.overlay).length, 1);
    assert.throws(() => pipe.setOverlay('intro', true), /Item not found/); assert.throws(() => pipe.setOverlay('av2', true), /Item not found/);
    pipe.setOverlayAll(true); assert.ok(planFile().items.every((i) => i.overlay === true)); pipe.setOverlayAll(false); assert.ok(planFile().items.every((i) => i.overlay === false));
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'moments.json'))).moments.every((m) => !('overlay' in m)));
  });
  await t('A failed slide does not stop the others; step reports it; Make PNG slides retries only missing', async () => {
    pipe.openDir(dir); await pipe.runStep('plan'); const first = pipe.view().plan.items.find((i) => i.kind === 'png'); first.text += ' FAILME'; renders = 0;
    await assert.rejects(pipe.runStep('slides'), /failed/);
    const after = pipe.view().plan, ok = after.items.filter((i) => i.kind === 'png' && i.slide).length; assert.ok(ok >= 1); assert.ok(after.items.some((i) => i.error));
    renders = 99; await pipe.runStep('slides'); assert.ok(pipe.view().plan.items.filter((i) => i.kind === 'png').every((i) => i.slide));
  });
  await t('Get stock step only fills items without a file, and a new plan keeps overlay OFF', async () => {
    const before = mode.log.length; await pipe.runStep('stock');
    const plan = pipe.view().plan; assert.ok(plan.items.filter((i) => i.kind !== 'png').every((i) => i.file && fs.existsSync(path.join(dir, i.file)))); assert.ok(plan.items.every((i) => i.overlay === false));
    const again = mode.log.length; await pipe.runStep('stock'); assert.strictEqual(mode.log.length, again, 'second run does nothing'); assert.ok(again > before);
  });
  const prep = async (name) => { const d = path.join(tmp, name); pipe.openDir(d); pipe.setInput('audio', audioSrc); pipe.setInput('face', faceSrc); for (const st of ['transcribe', 'moments', 'plan']) await pipe.runStep(st); return d; };
  await t('No match on the stock site: stock items become PNG slides, reason is saved, counts show it', async () => {
    mode.noMatch = true; const d = await prep('p-nomatch'); const was = planFile(d).items.filter((i) => i.kind !== 'png').length; assert.ok(was > 0);
    await pipe.runStep('stock'); mode.noMatch = false; const plan = planFile(d);
    assert.ok(plan.items.every((i) => i.kind === 'png' && i.slide && fs.existsSync(path.join(d, i.slide)))); assert.strictEqual(plan.fallback, was); assert.strictEqual(plan.counts.png, plan.counts.total);
    assert.ok(plan.items.filter((i) => i.fallbackReason).every((i) => i.fallbackReason === 'no match' && ['clip', 'image'].includes(i.fallbackFrom)));
  });
  await t('Search fails (offline): items stay as stock, are NOT turned into PNG, message says retry', async () => {
    mode.netfail = true; const d = await prep('p-net'); await assert.rejects(pipe.runStep('stock'), /could not be searched/); mode.netfail = false;
    const plan = planFile(d); assert.ok(plan.items.some((i) => i.kind !== 'png') && plan.fallback === 0);
    await pipe.runStep('stock'); assert.ok(pipe.view().plan.items.filter((i) => i.kind !== 'png').every((i) => i.file));
  });
  await t('Wrong Pexels key stops at once with a clear message', async () => {
    mode.auth401 = true; await prep('p-401'); await assert.rejects(pipe.runStep('stock'), /Pexels 401: key rejected/); mode.auth401 = false;
  });
  await t('Pixabay first when chosen in settings (and used when it is the only key)', async () => {
    KEYS.pixabay = 'xk'; const d = await prep('p-pix'); pipe.saveSettings({ ...pipe.view().settings, searchOrder: 'pixabay' }); await pipe.runStep('stock');
    const st = planFile(d).items.filter((i) => i.kind !== 'png'); assert.ok(st.length && st.every((i) => i.source.site === 'pixabay'), st.map((i) => i.source && i.source.site).join());
    assert.ok(st.every((i) => fs.existsSync(path.join(d, i.file)))); KEYS.pixabay = '';
  });
  await t('No stock key at all: Run all stops before the slow steps; Get stock says what to do', async () => {
    KEYS.pexels = ''; const d = path.join(tmp, 'p-nokey'); pipe.openDir(d); pipe.setInput('audio', audioSrc); const g = mode.groq;
    await assert.rejects(pipe.runStep('all'), /Add a Pexels or Pixabay key/); assert.strictEqual(mode.groq, g, 'no Groq call was made'); KEYS.pexels = 'pk';
  });
  await t('Settings are saved, cleaned and used by the next plan', async () => {
    pipe.openDir(dir); pipe.saveSettings({ maxClips: 2, maxSec: 10, pngPct: 100, clipImageRatio: 4, maxStockRow: 2 }); await pipe.runStep('plan');
    const pl = pipe.view().plan; assert.ok(pl.items.every((i) => i.kind === 'png')); const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))); assert.strictEqual(s.maxClips, 2);
    assert.strictEqual(proj.cleanSettings({ maxClips: -5, pngPct: 900, maxSec: 'x' }).maxClips, 1);
  });
  await t('Changing the audio clears old transcript, moments, plan and slides', async () => {
    pipe.setInput('audio', audioSrc); assert.ok(!fs.existsSync(path.join(dir, 'plan.json'))); assert.strictEqual(fs.readdirSync(path.join(dir, 'slides')).length, 0);
  });
  await t('Busy guard: a second step cannot start while one runs; Cancel stops', async () => {
    const p1 = pipe.runStep('all'); await assert.rejects(pipe.runStep('moments'), /Another step/); pipe.cancel(); await p1.catch(() => {});
  });
  await t('Cancel answers at once even when a slide is slow, and nothing is saved after it', async () => {
    for (let i = 0; i < 80 && pipe.view().busy; i++) await new Promise((r) => setTimeout(r, 100)); // the cancelled run above may still be winding down
    await pipe.runStep('all'); const it = pipe.view().plan.items.find((i) => i.kind === 'png'); const before = it.slide;
    const orig = SlideEngine.prototype.render; SlideEngine.prototype.render = () => new Promise((r) => setTimeout(() => r({ slide: 'slides/LATE.png', layout: 'chain', style: 'clay' }), 1500));
    try {
      const t0 = Date.now(), p1 = pipe.regenerate(it.id); setTimeout(() => pipe.cancel(), 100);
      await assert.rejects(p1, /cancelled/); assert.ok(Date.now() - t0 < 1000, 'Cancel took ' + (Date.now() - t0) + ' ms');
      await new Promise((r) => setTimeout(r, 1800));
      assert.strictEqual(pipe.view().plan.items.find((i) => i.id === it.id).slide, before, 'a cancelled slide must not be saved'); assert.strictEqual(pipe.view().busy, false);
    } finally { SlideEngine.prototype.render = orig; }
  });
  await t('view() lists avatar clips for the preview', async () => { assert.deepStrictEqual(pipe.view().avatar, {}); });
  await t('keystore only accepts known key names (no path tricks)', () => {
    delete require.cache[require.resolve(S + '/keystore')]; const real = require(S + '/keystore'); assert.throws(() => real.setKey('../../evil', 'x'), /Unknown key name/);
  });

  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(dl, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
