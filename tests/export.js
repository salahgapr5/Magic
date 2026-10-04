// Part B tests with REAL ffmpeg on tiny files (320x180, 8 s). Run: node tests/export.js
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const { spawnSync } = require('child_process');
const FF = process.env.VEM_FFMPEG || 'ffmpeg', FP = process.env.VEM_FFPROBE || 'ffprobe';
const origLoad = Module._load;
Module._load = function (req, ...a) {
  if (req === 'electron') return { app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, setPath() {} }, safeStorage: { isEncryptionAvailable: () => false }, BrowserWindow: class {} };
  if (req === 'ffmpeg-static') return FF;
  if (req === 'ffprobe-static') return { path: FP };
  return origLoad.call(this, req, ...a);
};
const S = path.join(__dirname, '..', 'src');
const X = require(S + '/modules/export');
const AI = require(S + '/modules/avatar-interface');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 4).join('\n       ')); } };
const ff = (...a) => { const r = spawnSync(FF, ['-y', '-v', 'error', ...a]); assert.strictEqual(r.status, 0, String(r.stderr)); };
const probe = (f) => JSON.parse(spawnSync(FP, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', f]).stdout);
function pixel(file, sec) { // center colour [r,g,b] at a time
  const r = spawnSync(FF, ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'crop=4:4:(iw-4)/2:(ih-4)/2,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...r.stdout];
}
const near = (p, want, tol = 45) => p.every((v, i) => Math.abs(v - want[i]) <= tol);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pbtest-'));
const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('vem-render-')).length;

function makeProject(name, { withClip = true, overlayOn = true } = {}) {
  const d = path.join(tmpRoot, name); for (const s of ['slides', 'stock', 'avatar']) fs.mkdirSync(path.join(d, s), { recursive: true });
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:a', 'libmp3lame', path.join(d, 'audio.mp3'));
  ff('-f', 'lavfi', '-i', 'color=c=0x00ffff:s=200x300', '-frames:v', '1', path.join(d, 'face.png'));               // portrait cyan face
  ff('-f', 'lavfi', '-i', 'color=c=red:s=1920x1080', '-frames:v', '1', path.join(d, 'slides/b1.png'));            // red slide
  ff('-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=5:r=25', '-pix_fmt', 'yuv420p', path.join(d, 'stock/b2.mp4')); // blue stock clip, 5 s
  ff('-f', 'lavfi', '-i', 'color=c=green:s=800x450', '-frames:v', '1', path.join(d, 'stock/b3.jpg'));            // green stock image
  ff('-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1:r=25,drawbox=x=100:y=50:w=120:h=80:color=white:t=fill', '-pix_fmt', 'yuv420p', path.join(d, 'overlay.mp4')); // silent, 1 s, white box
  if (withClip) {
    ff('-f', 'lavfi', '-i', 'color=c=yellow:s=320x180:d=4:r=25', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(d, 'avatar/intro.mp4'));
    fs.writeFileSync(path.join(d, 'avatar-clips.json'), JSON.stringify({ version: 1, clips: [{ id: 'intro', file: 'avatar/intro.mp4', width: 320, height: 180, hasAudio: true }] }));
  }
  const moments = { version: 1, moments: [{ id: 'intro', type: 'intro', start: 0, end: 2, title: 'Intro' }, { id: 'av2', type: 'avatar', start: 7, end: 8, title: 'Two' }] };
  const plan = { version: 1, items: [
    { id: 'b1', start: 2, end: 4, kind: 'png', slide: 'slides/b1.png', text: 'x', overlay: false },
    { id: 'b2', start: 4, end: 6, kind: 'clip', file: 'stock/b2.mp4', text: 'y', overlay: overlayOn },
    { id: 'b3', start: 6, end: 7, kind: 'image', file: 'stock/b3.jpg', text: 'z', overlay: false } ], counts: {} };
  return { d, data: { project: { audio: 'audio.mp3', face: 'face.png', overlay: 'overlay.mp4' }, moments, plan } };
}

(async () => {
  console.log('export (real ffmpeg, tiny files)');
  await t('timeline: holes get a face still, overlaps are clamped, ends exactly at the audio length', () => {
    const r = X.tile([{ start: 0, end: 2, id: 'a' }, { start: 2.01, end: 4, id: 'b' }, { start: 3.5, end: 5, id: 'c' }, { start: 6, end: 9, id: 'd' }], 8);
    assert.strictEqual(r.holes, 1);
    assert.deepStrictEqual(r.spans.map((x) => [x.start, x.end, !!x.hole]), [[0, 2, false], [2, 4, false], [4, 5, false], [5, 6, true], [6, 8, false]]);
    assert.deepStrictEqual(X.tile([{ start: 0, end: 7.95 }], 8.04).spans.map((x) => [x.start, x.end, !!x.hole]), [[0, 8.04, false]], 'small audio padding stretches the last item');
    const e = X.tile([{ start: 0, end: 3 }], 8); assert.deepStrictEqual(e.spans.map((x) => [x.start, x.end, !!x.hole]), [[0, 3, false], [3, 8, true]]);
  });
  await t('One audio file gives a finished video: avatar clip, PNG, stock clip (cut), stock image, face still; right size, length and audio', async () => {
    const { d, data } = makeProject('full'); const prog = [];
    const r = await X.exportVideo(d, data, { height: 180, onProgress: (p) => prog.push(p.pct) });
    const f = path.join(d, 'final.mp4'); assert.ok(fs.existsSync(f)); assert.ok(!fs.existsSync(path.join(d, 'final.part.mp4')));
    const p = probe(f), v = p.streams.find((s) => s.codec_type === 'video'), a = p.streams.find((s) => s.codec_type === 'audio');
    assert.strictEqual(v.width, 320); assert.strictEqual(v.height, 180); assert.ok(a, 'has audio'); assert.ok(Math.abs(Number(p.format.duration) - 8) < 0.25, 'duration ' + p.format.duration);
    assert.ok(prog.length && prog[prog.length - 1] === 100, 'progress reaches 100');
    assert.ok(near(pixel(f, 1), [255, 255, 0]), 'intro = yellow avatar clip, got ' + pixel(f, 1));
    assert.ok(near(pixel(f, 3), [255, 0, 0]), 'PNG = red, got ' + pixel(f, 3));
    assert.ok(near(pixel(f, 6.5), [0, 128, 0], 60), 'image = green, got ' + pixel(f, 6.5));
    assert.ok(near(pixel(f, 7.5), [0, 255, 255]), 'moment av2 has no clip -> face photo (cyan) in the middle, got ' + pixel(f, 7.5));
    assert.ok(r.stats.stills === 1);
  });
  await t('Overlay shows ONLY on B-roll items marked on (white box in the middle); never on avatar or other items', async () => {
    const full = path.join(tmpRoot, 'full', 'final.mp4');
    assert.ok(near(pixel(full, 5), [255, 255, 255], 60), 'item b2 (overlay on) has the white box, got ' + pixel(full, 5));
    assert.ok(near(pixel(full, 3), [255, 0, 0]), 'item b1 (overlay off) is clean');
    assert.ok(near(pixel(full, 1), [255, 255, 0]), 'avatar moment is clean');
  });
  await t('A stock clip longer than its slot is cut, not sped up (5 s clip in a 2 s slot ends at the slot end)', async () => {
    const full = path.join(tmpRoot, 'full', 'final.mp4'); assert.ok(near(pixel(full, 5.9), [255, 255, 255], 60) || near(pixel(full, 5.9), [0, 0, 255], 60)); assert.ok(!near(pixel(full, 6.2), [0, 0, 255], 20), 'at 6.2 s the next item (green) is shown');
  });
  await t('No avatar-clips.json: every avatar moment is the face photo (no crash)', async () => {
    const { d, data } = makeProject('noclips', { withClip: false }); await X.exportVideo(d, data, { height: 180 });
    assert.ok(near(pixel(path.join(d, 'final.mp4'), 1), [0, 255, 255]), 'intro = face photo');
  });
  await t('avatar-clips.json points to a missing file: face photo, no crash; clip path outside the project is ignored', async () => {
    const { d, data } = makeProject('badclip'); fs.writeFileSync(path.join(d, 'avatar-clips.json'), JSON.stringify({ version: 1, clips: [{ id: 'intro', file: 'avatar/gone.mp4' }, { id: 'av2', file: '../outside.mp4' }] }));
    assert.strictEqual(AI.clipMap(d).size, 0); await X.exportVideo(d, data, { height: 180 }); assert.ok(near(pixel(path.join(d, 'final.mp4'), 1), [0, 255, 255]));
  });
  await t('Crossfade (transition 0.3 s) works with the same graph', async () => {
    const { d, data } = makeProject('trans'); await X.exportVideo(d, data, { height: 180, transition: 0.3 });
    const p = probe(path.join(d, 'final.mp4')); assert.ok(Math.abs(Number(p.format.duration) - 8) < 0.25); assert.ok(near(pixel(path.join(d, 'final.mp4'), 3), [255, 0, 0], 60));
  });
  await t('Crossfade setting: saved (0 to 1 s), cleaned, and used by the Export button path', async () => {
    const proj = require(S + '/modules/project'); assert.strictEqual(proj.cleanSettings({}).transition, 0); assert.strictEqual(proj.cleanSettings({ transition: 9 }).transition, 1); assert.strictEqual(proj.cleanSettings({ transition: -2 }).transition, 0); assert.strictEqual(proj.cleanSettings({ transition: 'x' }).transition, 0);
    const pipe = require(S + '/pipeline'); const { d, data } = makeProject('xf'); for (const f of ['project', 'moments', 'plan']) fs.writeFileSync(path.join(d, f + '.json'), JSON.stringify(data[f]));
    pipe.openDir(d); pipe._setExportOpts({ height: 180 }); pipe.saveSettings({ ...pipe.view().settings, transition: 0.4 }); assert.strictEqual(pipe.view().settings.transition, 0.4);
    await pipe.exportVideo(); // real run with crossfade
    const p = probe(path.join(d, 'final.mp4')); assert.ok(Math.abs(Number(p.format.duration) - 8) < 0.25); assert.ok(near(pixel(path.join(d, 'final.mp4'), 3), [255, 0, 0], 60));
  });
  await t('Missing PNG slide or stock file: clear message before ffmpeg starts, nothing left behind', async () => {
    const { d, data } = makeProject('missing'); fs.unlinkSync(path.join(d, 'slides/b1.png'));
    await assert.rejects(X.exportVideo(d, data, { height: 180 }), /1 PNG slide\(s\) are not made yet \(b1\)/);
    fs.writeFileSync(path.join(d, 'slides/b1.png'), ''); data.plan.items[1].file = null; fs.unlinkSync(path.join(d, 'slides/b1.png'));
    ff('-f', 'lavfi', '-i', 'color=c=red:s=1920x1080', '-frames:v', '1', path.join(d, 'slides/b1.png'));
    await assert.rejects(X.exportVideo(d, data, { height: 180 }), /1 stock item\(s\) have no file yet \(b2\)/); assert.ok(!fs.existsSync(path.join(d, 'final.mp4')));
  });
  await t('Overlay switched on but overlay clip missing: warning, export still works', async () => {
    const { d, data } = makeProject('noov'); data.project.overlay = null; const r = await X.exportVideo(d, data, { height: 180 });
    assert.ok(r.warnings.some((w) => /overlay clip is missing/.test(w))); assert.ok(near(pixel(path.join(d, 'final.mp4'), 5), [0, 0, 255], 60));
  });
  await t('Cancel: ffmpeg is stopped, no final.mp4, no .part file, no temp folder left', async () => {
    const { d, data } = makeProject('cancel'); const before = leftovers(); const ctl = { cancelled: false, proc: null };
    const p = X.exportVideo(d, data, { height: 180, ctl, onProgress: () => {} });
    const iv = setInterval(() => { if (ctl.proc) { ctl.cancelled = true; ctl.proc.kill('SIGKILL'); clearInterval(iv); } }, 5);
    await assert.rejects(p, /cancelled/); clearInterval(iv);
    assert.ok(!fs.existsSync(path.join(d, 'final.mp4')) && !fs.existsSync(path.join(d, 'final.part.mp4'))); assert.strictEqual(leftovers(), before);
  });
  await t('Error (broken stock file): message names the file, nothing left behind', async () => {
    const { d, data } = makeProject('broken'); const before = leftovers(); fs.writeFileSync(path.join(d, 'stock/b2.mp4'), 'not a video');
    await assert.rejects(X.exportVideo(d, data, { height: 180 }), /Cannot read clip b2 \(b2\.mp4\)/); assert.strictEqual(leftovers(), before); assert.ok(!fs.existsSync(path.join(d, 'final.mp4')));
  });
  await t('Real 1080p: 1920x1080 even size (tiny 4 s project)', async () => {
    const { d, data } = makeProject('hd'); data.moments.moments = [{ id: 'intro', type: 'intro', start: 0, end: 2, title: '' }]; data.plan.items = [data.plan.items[0]]; data.plan.items[0].start = 2; data.plan.items[0].end = 4;
    ff('-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'libmp3lame', path.join(d, 'audio.mp3'));
    await X.exportVideo(d, data, {}); const v = probe(path.join(d, 'final.mp4')).streams.find((s) => s.codec_type === 'video');
    assert.strictEqual(v.width, 1920); assert.strictEqual(v.height, 1080);
  });
  await t('App level: Export button path writes final.mp4, shows progress, Cancel stops it, busy guard works', async () => {
    const pipe = require(S + '/pipeline'); const { d, data } = makeProject('app');
    for (const f of ['project', 'moments', 'plan']) fs.writeFileSync(path.join(d, f + '.json'), JSON.stringify(data[f]));
    pipe.openDir(d); pipe._setExportOpts({ height: 180 }); const msgs = []; pipe.setEmitter((p) => msgs.push(p.step + ':' + Math.round(p.pct * 100)));
    const v = await pipe.exportVideo(); assert.strictEqual(v.finalVideo, 'final.mp4'); assert.ok(msgs.includes('export:100'));
    fs.unlinkSync(path.join(d, 'final.mp4'));
    const p1 = pipe.exportVideo(); await assert.rejects(pipe.exportVideo(), /Another step/); pipe.cancel(); await assert.rejects(p1, /cancelled/);
    assert.ok(!fs.existsSync(path.join(d, 'final.mp4')) && !fs.existsSync(path.join(d, 'final.part.mp4'))); assert.strictEqual(pipe.view().busy, false);
    fs.copyFileSync(path.join(d, 'audio.mp3'), path.join(tmpRoot, 'a2.mp3')); pipe.setInput('audio', path.join(tmpRoot, 'a2.mp3')); assert.strictEqual(pipe.view().finalVideo, null);
  });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
