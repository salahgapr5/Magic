// Shared bits for stock adapters. An adapter is: { id, name, free, searchVideos(args), searchImages(args), resolve(candidate) }
// A candidate: { site, id, kind:'clip'|'image', url, preview, page, width, height, duration }
// `url` is the real file. For a paid site later: put the search/preview data here and fetch the licensed file in resolve() at export time.
const RATIO = 16 / 9;
const is169 = (w, h) => w > 0 && h > 0 && Math.abs(w / h - RATIO) < 0.03;
const isFullHD = (w, h) => w >= 1920 && h >= 1080;

async function getJson(url, { headers, signal, fetchImpl, site }) {
  const f = fetchImpl || fetch;
  let res;
  try { res = await f(url, { headers, signal: signal ? (AbortSignal.any ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : signal) : AbortSignal.timeout(30000) }); }
  catch (e) { if (e.name === 'AbortError' && signal && signal.aborted) throw e; const err = new Error(site + ' search failed: ' + (e.message || e)); err.network = true; throw err; }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(site + ' ' + res.status + (res.status === 401 || res.status === 403 ? ': key rejected. Check it in Keys.' : res.status === 429 ? ': too many requests. Wait a few minutes.' : ': search failed.'));
    err.fatal = res.status === 401 || res.status === 403; err.network = !err.fatal; throw err;
  }
  return j;
}
module.exports = { is169, isFullHD, getJson };
