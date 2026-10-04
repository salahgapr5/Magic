// One download helper for all stock sites. Follows redirects by hand, checks the status and the size,
// writes to a .part file first and removes it on any problem. A finished file appears only when complete.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const MAX_REDIRECTS = 6;
function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal && AbortSignal.any ? AbortSignal.any([signal, t]) : (signal || t);
}

async function download(url, dest, { signal, fetchImpl, timeoutMs = 180000, minBytes = 1000, accept } = {}) {
  const f = fetchImpl || fetch, part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    let cur = url, res;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS) throw new Error('Too many redirects.');
      res = await f(cur, { redirect: 'manual', signal: withTimeout(signal, timeoutMs) });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Redirect without a target (' + res.status + ').');
        cur = new URL(loc, cur).href; continue;
      }
      break;
    }
    if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
    const type = String(res.headers.get('content-type') || '');
    if (/text\/html|application\/json/i.test(type)) throw new Error('Download gave a web page, not a media file.');
    if (accept && type && !accept.test(type) && !/octet-stream/i.test(type)) throw new Error('Unexpected file type: ' + type);
    if (!res.body) throw new Error('Download had no data.');
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
    const size = fs.statSync(part).size, want = Number(res.headers.get('content-length') || 0);
    if (size < minBytes) throw new Error('Downloaded file is empty or too small.');
    if (want && size !== want) throw new Error('Download was cut off (' + size + ' of ' + want + ' bytes).');
    fs.renameSync(part, dest);
    return { bytes: size, type };
  } catch (e) {
    try { fs.unlinkSync(part); } catch {}
    throw e;
  }
}
module.exports = { download };
