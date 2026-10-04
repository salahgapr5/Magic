const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
// Share the encrypted API-key store with the existing SalMedia app.
try { app.setPath('userData', path.join(app.getPath('appData'), 'SalMedia')); } catch {}
const keystore = require('./keystore');
const pipeline = require('./pipeline');

let win = null;
const lastFile = () => path.join(app.getPath('userData'), 'pipeline-last-project.json');
function createWindow() {
  win = new BrowserWindow({ width: 1400, height: 940, minWidth: 1100, minHeight: 720, title: 'SalMedia Pipeline',
    icon: path.join(__dirname, 'icon.png'), backgroundColor: '#f5f7fb',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
}
pipeline.setEmitter((p) => { if (win && !win.isDestroyed()) win.webContents.send('progress', p); });

// Every call answers {ok:true,state} or {ok:false,error}. The screen never has to guess.
const handle = (name, fn) => ipcMain.handle(name, async (_, ...a) => {
  try { return { ok: true, state: await fn(...a) }; }
  catch (e) { const m = String((e && e.message) || e); return { ok: false, cancelled: m === 'cancelled', error: m === 'cancelled' ? 'Cancelled.' : m }; }
});
const FILTERS = { audio: [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }], face: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }], image: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  video: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }], media: [{ name: 'Video or image', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'png', 'jpg', 'jpeg', 'webp'] }] };
async function pickFile(kind) { const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS[kind] }); return r.canceled ? null : r.filePaths[0]; }
async function pickDir(title) { const r = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; }
function remember(dir) { try { fs.writeFileSync(lastFile(), JSON.stringify({ dir })); } catch {} }

handle('state', () => {
  if (!pipeline.view().dir) { try { const d = JSON.parse(fs.readFileSync(lastFile(), 'utf8')).dir; if (d && fs.existsSync(d)) pipeline.openDir(d); } catch {} }
  return pipeline.view();
});
handle('project', async (mode) => { const d = await pickDir(mode === 'new' ? 'Create or choose an empty folder for the new project' : 'Choose the project folder'); if (!d) return pipeline.view(); remember(d); return pipeline.openDir(d); });
handle('pick-input', async (kind) => { const f = await pickFile(kind === 'overlay' ? 'video' : kind); if (!f) return pipeline.view(); return kind === 'overlay' ? pipeline.setOverlayClip(f) : pipeline.setInput(kind, f); });
handle('settings', (s) => pipeline.saveSettings(s));
handle('run', (step) => pipeline.runStep(step));
handle('regenerate', (id) => pipeline.regenerate(id));
handle('replace', async (id) => { const f = await pickFile(pipeline.itemKind(id) === 'png' ? 'image' : 'media'); return f ? pipeline.replace(id, f) : pipeline.view(); });
handle('overlay', (id, on) => pipeline.setOverlay(id, on));
handle('overlay-all', (on) => pipeline.setOverlayAll(on));
handle('delete', (id) => pipeline.remove(id));
handle('export', () => pipeline.exportVideo());
ipcMain.handle('cancel', () => { pipeline.cancel(); return true; });
ipcMain.handle('get-key', (_, n) => keystore.getKey(n));
ipcMain.handle('set-key', (_, n, v) => keystore.setKey(n, v));
ipcMain.handle('reveal', (_, p) => shell.showItemInFolder(p));
ipcMain.handle('default-model', () => pipeline.DEFAULT_MODEL);

app.whenReady().then(createWindow);
app.on('before-quit', () => pipeline.shutdown());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
