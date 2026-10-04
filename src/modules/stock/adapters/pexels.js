// Pexels (free). Videos: /videos/search. Photos: /v1/search.
const { is169, isFullHD, getJson } = require('./util');
const H = (key) => ({ Authorization: key });

async function searchVideos({ query, key, signal, fetchImpl }) {
  const j = await getJson('https://api.pexels.com/videos/search?orientation=landscape&size=large&per_page=20&query=' + encodeURIComponent(query), { headers: H(key), signal, fetchImpl, site: 'Pexels' });
  const out = [];
  for (const v of j.videos || []) {
    // the smallest mp4 that is still 1920x1080 or bigger and 16:9
    const files = (v.video_files || []).filter((f) => /mp4/i.test(f.file_type || '') && f.link && isFullHD(f.width, f.height) && is169(f.width, f.height)).sort((a, b) => a.width * a.height - b.width * b.height);
    if (!files.length) continue;
    out.push({ site: 'pexels', id: String(v.id), kind: 'clip', url: files[0].link, preview: v.image || '', page: v.url || '', width: files[0].width, height: files[0].height, duration: Number(v.duration) || 0 });
  }
  return out;
}
async function searchImages({ query, key, signal, fetchImpl }) {
  const j = await getJson('https://api.pexels.com/v1/search?orientation=landscape&size=large&per_page=20&query=' + encodeURIComponent(query), { headers: H(key), signal, fetchImpl, site: 'Pexels' });
  const out = [];
  for (const p of j.photos || []) {
    if (!isFullHD(p.width, p.height) || !p.src) continue;
    out.push({ site: 'pexels', id: String(p.id), kind: 'image', url: p.src.original || p.src.large2x, preview: p.src.medium || p.src.large || '', page: p.url || '', width: p.width, height: p.height });
  }
  return out;
}
module.exports = { id: 'pexels', name: 'Pexels', free: true, searchVideos, searchImages, resolve: async (c) => c.url };
