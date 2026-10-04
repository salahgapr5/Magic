// OpenAI picks the style and layout for each PNG item from its script. Code checks the answer.
const { chatJSON } = require('../openai');
const STYLES = ['aurora', 'sunrise', 'ocean', 'clay'];
const LAYOUTS = ['hero','mythfact','beforeafter','chain','bignum','checklist','cycle','grid','story','claim','bars','timeline','anatomy','mechanism','scenecompare','spine','stairs','column','orbit','hublist','tree','quad'];

function check(raw, items, rng) {
  const byId = new Map((Array.isArray(raw) ? raw : []).map((x) => [x && x.id, x]));
  let prevLayout = '';
  return items.map((it) => {
    const r = byId.get(it.id) || {};
    const style = STYLES.includes(r.style) ? r.style : STYLES[Math.floor(rng() * STYLES.length)];
    let layout = LAYOUTS.includes(r.layout) ? r.layout : '';
    if (layout && layout === prevLayout) layout = ''; // never the same layout twice in a row
    prevLayout = layout || prevLayout;
    return { id: it.id, style, layout };
  });
}
async function pickStyles({ items, key, model, rng, signal, fetchImpl }) {
  if (!items.length) return [];
  const system = 'You are an art director. For each B-roll slide, pick a visual style and a layout that fits the spoken words. Return JSON only: {"items":[{"id":"b1","style":"clay","layout":"chain"}]}.';
  const user = `Styles: ${STYLES.join(', ')} (aurora = dark glass, sunrise = warm light, ocean = clean blue light, clay = bold 3D blue).\nLayouts: ${LAYOUTS.join(', ')}.\nUse a mix of styles, but keep one style for a run of related ideas. Never use the same layout on two slides in a row. Use bars only when numbers are compared, bignum only for one key number.\n\nItems:\n` +
    items.map((i) => `${i.id}: ${String(i.text || '').slice(0, 220)}`).join('\n');
  let raw = [];
  try { raw = (await chatJSON({ key, model, system, user, maxTokens: 6000, signal, fetchImpl })).items; }
  catch (e) { if (e.name === 'AbortError' || /OpenAI 4(01|03|04)/.test(e.message)) throw e; /* any other problem: styles are picked by code */ }
  return check(raw, items, rng);
}
module.exports = { pickStyles, check, STYLES, LAYOUTS };
