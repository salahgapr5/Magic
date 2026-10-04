// Slide engine, headless: hidden Electron windows run engine.html (my slide tool) and return 1920x1080 PNG files.
const fs = require('fs');
const path = require('path');
const POOL = 3;
const SLIDE_TIMEOUT_MS = 150000; // one slide may not take longer than this; its window is closed and the slide counts as failed // windows working at the same time (the engine keeps state per window, so one job per window)

class SlideEngine {
  constructor() { this.wins = []; this.free = []; this.waiters = []; }
  async _create() {
    const { BrowserWindow } = require('electron');
    const w = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await w.loadFile(path.join(__dirname, 'engine.html'));
    for (let i = 0; i < 100; i++) { // icons file is 16 MB: wait until the API exists
      if (await w.webContents.executeJavaScript('!!window.SLIDEAPI')) return w;
      await new Promise((r) => setTimeout(r, 200));
    }
    w.destroy(); throw new Error('Slide engine did not start.');
  }
  async _acquire() {
    if (this.free.length) return this.free.pop();
    if (this.wins.length < POOL) { const w = await this._create(); this.wins.push(w); return w; }
    return new Promise((res, rej) => this.waiters.push({ res, rej }));
  }
  _release(w) {
    if (w.__dead) { // closed after a timeout or Cancel: give a waiting job a fresh window
      this.wins = this.wins.filter((x) => x !== w);
      if (this.waiters.length && !this.destroyed) this._create().then((nw) => { this.wins.push(nw); const n = this.waiters.shift(); if (n) n.res(nw); else this.free.push(nw); }, (e) => { const n = this.waiters.shift(); if (n) n.rej(e); });
      return;
    }
    const n = this.waiters.shift(); if (n) n.res(w); else this.free.push(w);
  }
  _kill(w) { w.__dead = true; this.free = this.free.filter((x) => x !== w); try { w.destroy(); } catch {} }
  _run(w, code) { // run code in the window, but never wait forever
    let t; const limit = new Promise((_, rej) => { t = setTimeout(() => { this._kill(w); rej(new Error('The slide took too long (over ' + SLIDE_TIMEOUT_MS / 1000 + ' s) and was stopped.')); }, SLIDE_TIMEOUT_MS); });
    return Promise.race([w.webContents.executeJavaScript(code), limit]).finally(() => clearTimeout(t));
  }

  // item: {id,text,start}  opts: {dir,key,model,style,layout,avoidLayout}  -> relative path of the PNG
  async render(item, opts) {
    const w = await this._acquire();
    try {
      const o = { key: opts.key, model: opts.model, style: opts.style, layout: opts.layout, avoidLayout: opts.avoidLayout, text: item.text, start: item.start, icons: 'mine' };
      let res, err;
      for (let a = 0; a < 2 && !res; a++) {
        try { res = await this._run(w, 'SLIDEAPI.makeSlide(' + JSON.stringify(o) + ')'); } catch (e) { err = e; if (w.__dead || /Incorrect API key|OpenAI 4(01|03)/.test(String(e.message))) break; }
      }
      if (!res) throw new Error(String((err && err.message) || err || 'Slide failed').replace(/^Error invoking remote method.*?: /, ''));
      const png = await this._run(w, 'SLIDEAPI.toPng(' + JSON.stringify(res.svg) + ',1920,1080)');
      const rel = 'slides/' + item.id + '.png';
      fs.mkdirSync(path.join(opts.dir, 'slides'), { recursive: true });
      fs.writeFileSync(path.join(opts.dir, rel), Buffer.from(png.split(',')[1], 'base64'));
      return { slide: rel, layout: res.layout, style: o.style };
    } finally { this._release(w); }
  }
  destroy() { // also used by Cancel: closes every window and lets waiting jobs fail at once
    this.destroyed = true;
    for (const w of this.wins) { w.__dead = true; try { w.destroy(); } catch {} }
    this.wins = []; this.free = [];
    for (const n of this.waiters.splice(0)) n.rej(new Error('cancelled'));
  }
}
module.exports = { SlideEngine, POOL };
