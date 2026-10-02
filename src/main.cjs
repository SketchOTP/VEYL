'use strict';

const { app, BrowserWindow, ipcMain, protocol, session, shell, clipboard, ClipboardItem, safeStorage, Menu } = require('electron');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const { FilesystemService, absolute, identity, describeError } = require('./filesystem.cjs');
const { FileClipboard } = require('./file-clipboard.cjs');
const { FolderWatch } = require('./folder-watch.cjs');
const { Librarian } = require('./librarian.cjs');
const { AgentSettings } = require('./agent-settings.cjs');
const { SelectedProvider } = require('./selected-provider.cjs');

app.setName('VEYL');
if (process.platform === 'linux') app.setDesktopName('io.github.SketchOTP.VEYL.desktop');
const appIcon = path.join(__dirname, '..', 'assets', 'veyl.png');

// Fixture hooks keep UI verification away from the real home and saved application state.
app.setPath('userData', process.env.SYSTEMUS_USER_DATA ? absolute(process.env.SYSTEMUS_USER_DATA) : path.join(app.getPath('appData'), 'systemus'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'systemus', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'systemus-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);
app.enableSandbox();

const rendererRoot = path.join(__dirname, 'renderer');
const { FileIcons } = require('./file-icons.cjs');
const { ImageDecoder } = require('./image-decoder.cjs');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' systemus-media: data:; media-src systemus-media:; frame-src systemus-media:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const rendererFiles = new Map([
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/settings.js', ['settings.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icons.js', ['icons.js', 'text/javascript; charset=utf-8']],
  ['/file-type-icons.js', ['file-type-icons.js', 'text/javascript; charset=utf-8']],
  ['/image-decoder.html', ['image-decoder.html', 'text/html; charset=utf-8']],
  ['/image-decoder.js', ['image-decoder.js', 'text/javascript; charset=utf-8']]
]);
let window, service, librarian, fileClipboard, folderWatch, fileIcons, imageDecoder, agentSettings, iconShutdown, quitting = false;
const mediaTokens = new Map();

function trusted(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== 'systemus://app/index.html') throw new Error('Untrusted IPC sender.');
}
function handle(channel, action) {
  ipcMain.handle(channel, async (event, data) => {
    trusted(event);
    try { return { ok: true, value: await action(data, event) }; }
    catch (error) { const result=describeError(error);if(agentSettings)result.message=agentSettings.redact(result.message);return { ok: false, error: result }; }
  });
}
async function mediaToken(file) {
  const preview = await service.preview(file);
  if (!['image', 'audio', 'video', 'pdf'].includes(preview.type)) return preview;
  const token = randomUUID();
  mediaTokens.set(token, { path: preview.entry.path, identity: preview.entry.identity, expires: Date.now() + 15 * 60 * 1000 });
  for (const [key, value] of mediaTokens) if (value.expires < Date.now()) mediaTokens.delete(key);
  while (mediaTokens.size > 1500) mediaTokens.delete(mediaTokens.keys().next().value);
  return { ...preview, url: `systemus-media://preview/${token}` };
}

async function registerProtocols() {
  protocol.handle('systemus', async request => {
    const url = new URL(request.url);
    const asset = url.hostname === 'app' ? rendererFiles.get(url.pathname) : null;
    if (!asset || request.method !== 'GET') return new Response('Not found', { status: 404 });
    return new Response(await fs.readFile(path.join(rendererRoot, asset[0])), { headers: { 'Content-Type': asset[1], 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' } });
  });
  protocol.handle('systemus-media', async request => {
    let handle;
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'preview' || !['GET', 'HEAD'].includes(request.method)) return new Response('Forbidden', { status: 403 });
      const token = mediaTokens.get(url.pathname.slice(1));
      if (!token || token.expires < Date.now()) return new Response('Preview expired', { status: 404 });
      const media = await service.mediaFile(token.path, token.identity);
      handle = await fs.open(media.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (identity(await handle.stat()) !== token.identity) throw new Error('File changed.');
      let start = 0, end = media.size - 1, status = 200;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) { await handle.close(); handle = null; return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${media.size}` } }); }
        if (!match[1]) start = Math.max(0, media.size - Number(match[2]));
        else start = Number(match[1]);
        if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
        if (start > end || start >= media.size) { await handle.close(); handle = null; return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${media.size}` } }); }
        status = 206;
      }
      const headers = { 'Content-Type': media.mime, 'Content-Length': String(Math.max(0, end - start + 1)), 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'none'; object-src 'none'", 'Cache-Control': 'no-store' };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${media.size}`;
      if (request.method === 'HEAD' || media.size === 0) { await handle.close(); handle = null; return new Response(null, { status, headers }); }
      const stream = handle.createReadStream({ start, end, autoClose: true });
      handle = null; // The stream now owns the file descriptor, including cancellation.
      return new Response(Readable.toWeb(stream), { status, headers });
    } catch { if (handle) await handle.close().catch(() => {}); return new Response('Preview unavailable', { status: 404 }); }
  });
}

function registerIPC() {
  handle('agents:settings',()=>agentSettings.public());
  handle('agents:status',data=>{if(!['librarian','iconDesigner'].includes(data?.agent))throw new Error('Unknown VEYL agent.');return new SelectedProvider(agentSettings,data.agent).status();});
  handle('agents:docs',data=>{const info=require('./provider-catalog.cjs').CATALOG[data?.provider];if(!info)throw new Error('Unknown provider.');return shell.openExternal(info.docs);});
  handle('agents:update',async data=>{const settings=await agentSettings.update(data);if(window&&!window.isDestroyed())window.webContents.send('agents:updated',settings);return settings;});
  handle('file-icons:boot', () => fileIcons.boot());
  handle('file-icons:resolve', data => fileIcons.resolve(data.keys));
  handle('explorer:boot', () => service.places());
  handle('explorer:list', (data, event) => service.list(data, update => { if (!event.sender.isDestroyed()) event.sender.send('explorer:list-progress', update); }));
  handle('explorer:cancel-list', data => service.cancelList(data.id));
  handle('explorer:properties', data => service.properties(data.path));
  handle('explorer:preview', data => mediaToken(data.path));
  handle('explorer:mutate', (data, event) => {
    if (librarian.applying) throw new Error('VEYL is executing your requested changes. Wait or cancel before another file operation.');
    return service.mutate(data, update => { if (!event.sender.isDestroyed()) event.sender.send('explorer:operation-progress', update); });
  });
  handle('explorer:clipboard-copy', data => fileClipboard.copy(data.paths, Boolean(data.cut)));
  handle('explorer:clipboard-files', () => fileClipboard.read().then(value => value ? {action:value.action,paths:value.paths} : null));
  handle('explorer:clipboard-paste', (data,event) => {
    if (librarian.applying) throw new Error('Wait for VEYL to finish applying.');
    return fileClipboard.paste(data.destination,update=>{if(!event.sender.isDestroyed())event.sender.send('explorer:operation-progress',update);});
  });
  handle('explorer:watch', data => folderWatch.set(data.paths));
  handle('explorer:prepare-trash', data => service.prepareTrash(data.paths));
  handle('explorer:trash', () => service.listTrash());
  handle('explorer:settings', data => service.saveSettings(data));
  handle('explorer:search', (data, event) => service.startSearch(data, update => {
    if (!event.sender.isDestroyed()) event.sender.send('explorer:search-update', update);
  }));
  handle('explorer:cancel-search', data => service.cancelSearch(data.id));
  handle('explorer:external', async data => {
    const entry = await service.entry(await service.canonical(data.path));
    if (entry.type === 'symlink' || entry.type === 'special') throw new Error('Open symlinks and special files from their resolved location.');
    // Opening executables/desktop launchers is an explicit user action, never a preview side effect.
    if (data.reveal) { shell.showItemInFolder(entry.path); return { opened: true }; }
    const error = await shell.openPath(entry.path);
    if (error) throw new Error(error);
    return { opened: true };
  });
  const clean=value=>typeof value==='string'?agentSettings.redact(value):Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)])):value;
  const librarianEmit = event => update => { if (!event.sender.isDestroyed()) event.sender.send('librarian:update', clean(update)); };
  handle('librarian:boot', () => librarian.initialize());
  handle('librarian:send', async (data, event) => { await fileIcons.pause(); return librarian.start(data, librarianEmit(event)); });
  handle('librarian:approve', (data, event) => librarian.approve(data, librarianEmit(event)));
  handle('librarian:cancel', data => librarian.cancel(data?.id));
  handle('librarian:clear', () => librarian.clear());
  handle('librarian:scope', data => librarian.grantScope(data.path));
}

app.whenReady().then(async () => {
  service = new FilesystemService({ home: process.env.SYSTEMUS_HOME || os.homedir(), stateDir: app.getPath('userData'), trashRoot: process.env.SYSTEMUS_TRASH_ROOT });
  agentSettings=new AgentSettings({stateDir:app.getPath('userData'),safeStorage,onChange:()=>{librarian?.cancel();if(librarian)librarian.pending=null;fileIcons?.pause().catch(()=>{});imageDecoder?.close();}});
  await agentSettings.initialize();
  imageDecoder = new ImageDecoder({BrowserWindow});
  librarian = new Librarian({ filesystem: service, policy:agentSettings, provider:new SelectedProvider(agentSettings),imageDecode:(bytes,options)=>imageDecoder.decode(bytes,options), closeImageDecoder:()=>imageDecoder.close() });
  fileIcons = new FileIcons({stateDir:app.getPath('userData'),provider:new SelectedProvider(agentSettings,'iconDesigner'),canGenerate:()=>agentSettings.data.agents.iconDesigner.permissions.designIcons,isBusy:()=>Boolean(librarian.job||librarian.applying),emit:update=>{if(window&&!window.isDestroyed())window.webContents.send('file-icons:update',update);}});
  await fileIcons.initialize();
  fileClipboard = new FileClipboard({clipboard,ClipboardItem,filesystem:service});
  folderWatch = new FolderWatch({filesystem:service,emit:update=>{if(window&&!window.isDestroyed())window.webContents.send('explorer:folder-changed',update);}});
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await registerProtocols(); registerIPC();
  window = new BrowserWindow({ title: 'VEYL', width: 1520, height: 970, minWidth: 1000, minHeight: 650, backgroundColor: '#000000', icon: require('node:fs').existsSync(appIcon) ? appIcon : undefined, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false } });
  window.webContents.on('context-menu',(_event,params)=>{if(!params.isEditable&&!params.selectionText.trim())return;const template=params.isEditable?[{role:'cut',enabled:params.editFlags.canCut},{role:'copy',enabled:params.editFlags.canCopy},{role:'paste',enabled:params.editFlags.canPaste},{type:'separator'},{role:'selectAll'}]:[{role:'copy'},{role:'selectAll'}];Menu.buildFromTemplate(template).popup({window});});
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('closed', () => { folderWatch.close(); service.cancelAll(); librarian.cancel(); imageDecoder.close(); iconShutdown=fileIcons.shutdown(); window = null; });
  await window.loadURL('systemus://app/index.html');
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (!quitting && (librarian?.job || fileIcons?.active || iconShutdown)) {
    event.preventDefault(); quitting = true; Promise.all([librarian?.shutdown(),iconShutdown || fileIcons?.shutdown()]).finally(() => app.quit());
  }
});
