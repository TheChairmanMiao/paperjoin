const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, session, nativeImage } = require('electron');
const { readFile, stat, writeFile, rename, unlink } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { compressPdf } = require('./compression.cjs');

const APP_URL = 'paperjoin://app/index.html';
const MAX_FILE = 50 * 1024 * 1024;
const MAX_INPUT = 150 * 1024 * 1024;
const MAX_OUTPUT = 300 * 1024 * 1024;
let window;
let hasFiles = false;
let allowClose = false;
let closeDialogOpen = false;
let nativeDialogOpen = false;
let compressionInProgress = false;
app.setName('Paperjoin');
protocol.registerSchemesAsPrivileged([{ scheme: 'paperjoin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function trusted(event) {
  return window && !window.isDestroyed() && event.sender.id === window.webContents.id
    && event.senderFrame === window.webContents.mainFrame
    && event.senderFrame.url === APP_URL;
}
function requireTrusted(event) { if (!trusted(event)) throw new Error('This action is only available inside Paperjoin.'); }
function cleanName(name) {
  return path.basename(typeof name === 'string' ? name : 'combined-document.pdf').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 170) || 'combined-document.pdf';
}
function sendMenu(action) { if (window && !window.isDestroyed()) window.webContents.send('paperjoin:menu', action); }
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'Add Files…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
      { label: 'Export PDF…', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('export') },
      { type: 'separator' }, { role: 'close' },
    ] },
    { label: 'Edit', submenu: [
      { label: 'Undo Page Change', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}
function createWindow() {
  allowClose = false; hasFiles = false;
  window = new BrowserWindow({
    width: 1200, height: 870, minWidth: 760, minHeight: 620,
    title: 'Paperjoin', backgroundColor: '#f8f8f5', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (allowClose || !hasFiles) return;
    event.preventDefault();
    if (closeDialogOpen) return;
    closeDialogOpen = true;
    dialog.showMessageBox(window, {
      type: 'question', message: 'Close this workspace?', detail: 'Your original files are unchanged. The page arrangement and any unsaved PDF will be cleared.',
      buttons: ['Keep Working', 'Close Workspace'], defaultId: 0, cancelId: 0, noLink: true,
    }).then(({ response }) => { if (response === 1) { allowClose = true; window.close(); } }).finally(() => { closeDialogOpen = false; });
  });
  window.on('closed', () => { window = null; });
  window.loadURL(APP_URL);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(async () => {
    const root = path.join(app.getAppPath(), 'dist');
    protocol.handle('paperjoin', async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad path', { status: 400 }); }
      const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Not found', { status: 404 });
      try { return await net.fetch(pathToFileURL(file).toString()); }
      catch { return new Response('Not found', { status: 404 }); }
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    // All application resources are bundled. No document or telemetry requests leave this Mac.
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    ipcMain.on('paperjoin:workspace', (event, value) => { if (trusted(event)) hasFiles = value === true; });
    ipcMain.handle('paperjoin:open', async (event) => {
      requireTrusted(event);
      if (nativeDialogOpen) return { files: [], errors: [] };
      nativeDialogOpen = true;
      try {
        const result = await dialog.showOpenDialog(window, { title: 'Add PDFs and Images', buttonLabel: 'Add Files', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDFs and Images', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }] });
        if (result.canceled) return { files: [], errors: [] };
        const files = [], errors = [];
        let total = 0;
        for (const file of result.filePaths) {
          const name = path.basename(file);
          try {
            const info = await stat(file);
            if (!info.isFile() || !info.size) throw new Error('This file is empty or cannot be read.');
            if (info.size > MAX_FILE) throw new Error('Choose a file smaller than 50 MB.');
            if (total + info.size > MAX_INPUT) throw new Error('Choose up to 150 MB of files at a time.');
            const bytes = await readFile(file);
            if (bytes.length > MAX_FILE || total + bytes.length > MAX_INPUT) throw new Error('This selection is too large.');
            total += bytes.length; files.push({ name, bytes });
          } catch (error) { errors.push(`${name}: ${error.message}`); }
        }
        return { files, errors };
      } finally { nativeDialogOpen = false; }
    });
    ipcMain.handle('paperjoin:compress', async (event, bytes, preset) => {
      requireTrusted(event);
      if (compressionInProgress) throw new Error('A PDF is already being compressed.');
      compressionInProgress = true;
      try {
        const helper = app.isPackaged
          ? path.join(process.resourcesPath, 'paperjoin-compress')
          : path.join(app.getAppPath(), 'native/bin/paperjoin-compress');
        return await compressPdf(bytes, preset, helper);
      } finally { compressionInProgress = false; }
    });
    ipcMain.handle('paperjoin:save', async (event, bytes, suggestedName) => {
      requireTrusted(event);
      if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes.length > MAX_OUTPUT || Buffer.from(bytes.subarray(0, 5)).toString() !== '%PDF-') throw new Error('This PDF could not be saved. Create the PDF again.');
      if (nativeDialogOpen) return { saved: false };
      nativeDialogOpen = true;
      let temporary;
      try {
        const name = cleanName(suggestedName);
        const result = await dialog.showSaveDialog(window, { title: 'Export Combined PDF', defaultPath: path.join(app.getPath('documents'), name), nameFieldLabel: 'Save as:', buttonLabel: 'Save PDF', filters: [{ name: 'PDF document', extensions: ['pdf'] }], properties: ['createDirectory'] });
        if (result.canceled || !result.filePath) return { saved: false };
        temporary = path.join(path.dirname(result.filePath), `.${path.basename(result.filePath)}.${randomUUID()}.tmp`);
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temporary, result.filePath); temporary = null;
        return { saved: true, name: path.basename(result.filePath) };
      } catch { throw new Error('The PDF could not be saved in that folder. Choose a writable location and try again.'); }
      finally { if (temporary) await unlink(temporary).catch(() => {}); nativeDialogOpen = false; }
    });
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets/icon.png'));
    if (process.platform === 'darwin' && !icon.isEmpty()) app.dock.setIcon(icon);
    app.setAboutPanelOptions({ applicationName: 'Paperjoin', applicationVersion: app.getVersion(), copyright: 'Personal PDF workspace', version: '' });
    buildMenu(); createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else { window.show(); window.focus(); } });
  }).catch((error) => { console.error(error); dialog.showErrorBox('Paperjoin could not open', 'The application files could not be loaded. Try rebuilding the app.'); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
