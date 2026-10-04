// Shared OpenAI chat call (JSON answers). Used by moments and slides modules.
// `fetchImpl` can be replaced in tests.
const DEFAULT_MODEL = 'gpt-5.6-sol';
async function chatJSON({ key, model, system, user, maxTokens = 6000, signal, fetchImpl }) {
  if (!key) throw new Error('OpenAI key is missing. Open Keys and add it.');
  const f = fetchImpl || fetch;
  const body = {
    model: model || DEFAULT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
    max_completion_tokens: maxTokens,
  };
  let lastErr;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await f('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = 'OpenAI ' + r.status + ': ' + (j.error && j.error.message ? j.error.message : 'request failed');
        if (r.status === 429 || r.status >= 500) { lastErr = new Error(msg); await sleep(1500 * (a + 1)); continue; }
        throw new Error(msg);
      }
      const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return JSON.parse(txt);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (e instanceof SyntaxError) { lastErr = new Error('OpenAI returned text that is not JSON.'); continue; }
      if (/^OpenAI 4/.test(e.message) && !/429/.test(e.message)) throw e;
      lastErr = e;
      if (a < 2) await sleep(1000);
    }
  }
  throw lastErr || new Error('OpenAI request failed.');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { chatJSON, sleep, DEFAULT_MODEL };
