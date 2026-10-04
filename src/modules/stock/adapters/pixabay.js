// Pixabay (free). Videos: /api/videos/. Photos: /api/ (largeImageURL is 1280 px wide; fullHDURL only if Pixabay approved full access).
const { is169, isFullHD, getJson } = require('./util');

async function searchVideos({ query, key, signal, fetchImpl }) {
  const j = await getJson('https://pixabay.com/api/videos/?safesearch=true&per_page=20&key=' + encodeURIComponent(key) + '&q=' + encodeURIComponent(query), { signal, fetchImpl, site: 'Pixabay' });
  const out = [];
  for (const h of j.hits || []) {
    const v = ['large', 'medium'].map((k) => h.videos && h.videos[k]).find((x) => x && x.url && isFullHD(x.width, x.height) && is169(x.width, x.height));
    if (!v) continue;
    out.push({ site: 'pixabay', id: String(h.id), kind: 'clip', url: v.url, preview: h.videos.tiny && h.videos.tiny.url ? h.videos.tiny.url : '', page: h.pageURL || '', width: v.width, height: v.height, duration: Number(h.duration) || 0 });
  }
  return out;
}
async function searchImages({ query, key, signal, fetchImpl }) {
  const j = await getJson('https://pixabay.com/api/?image_type=photo&orientation=horizontal&min_width=1920&min_height=1080&safesearch=true&per_page=20&key=' + encodeURIComponent(key) + '&q=' + encodeURIComponent(query), { signal, fetchImpl, site: 'Pixabay' });
  const out = [];
  for (const h of j.hits || []) {
    const url = h.fullHDURL || h.largeImageURL; if (!url || !isFullHD(h.imageWidth, h.imageHeight)) continue;
    out.push({ site: 'pixabay', id: String(h.id), kind: 'image', url, preview: h.webformatURL || '', page: h.pageURL || '', width: h.imageWidth, height: h.imageHeight });
  }
  return out;
}
module.exports = { id: 'pixabay', name: 'Pixabay', free: true, searchVideos, searchImages, resolve: async (c) => c.url };
