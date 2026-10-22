const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { autoUpdater } = require('electron-updater')

const isDev = !!process.env.ONTIME_DEV
let win = null
let session = null

function engineCommand() {
  const packaged = path.join(process.resourcesPath || '', 'engine', process.platform === 'win32' ? 'engine.exe' : 'engine')
  if (app.isPackaged && fs.existsSync(packaged)) return { command: packaged, prefix: [] }
  const python = process.env.ONTIME_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  return { command: python, prefix: ['-I', path.join(__dirname, '..', 'engine', 'engine.py')] }
}

function runEngine(cmd, args) {
  return new Promise((resolve) => {
    const { command, prefix } = engineCommand()
    let child
    try {
      child = spawn(command, [...prefix, cmd], { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, error: 'No se pudo iniciar el motor local: ' + e.message })
      return
    }
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ ok: false, error: 'No se pudo iniciar el motor local: ' + e.message }))
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()))
      } catch {
        resolve({ ok: false, error: err.trim().split('\n').pop() || 'El motor local no respondió' })
      }
    })
    child.stdin.end(JSON.stringify(args))
  })
}

function snapshot(index) {
  return path.join(session.dir, `v${index}.pdf`)
}

function currentPath() {
  return snapshot(session.index)
}

function stateOf() {
  return {
    name: session.name,
    original: session.original,
    version: session.index + ':' + session.token,
    canUndo: session.index > 0,
    canRedo: session.index < session.last,
    dirty: session.index !== session.saved,
  }
}

async function openSession(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ontimepdf-'))
  const first = path.join(dir, 'v0.pdf')
  fs.copyFileSync(file, first)
  const info = await runEngine('info', { src: first })
  if (!info.ok) {
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: false, error: info.error }
  }
  if (session) fs.rmSync(session.dir, { recursive: true, force: true })
  session = { dir, original: file, name: path.basename(file), index: 0, last: 0, saved: 0, token: Date.now() }
  win.setTitle(`${session.name} - On Time PDF`)
  return { ok: true, state: stateOf() }
}

function pickFilters(kind) {
  if (kind === 'image') return [{ name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }]
  return [{ name: 'PDF', extensions: ['pdf'] }]
}

const SUPPORT_PHONE = '593995555799'
const SUPPORT_URL = `https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent('Hola, necesito ayuda con On Time PDF')}`

function macMenu() {
  return [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Ayuda', submenu: [{ label: 'Contactar a On Time Service por WhatsApp', click: () => shell.openExternal(SUPPORT_URL) }] },
  ]
}

function sendUpdate(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('update', payload)
}

function friendlyUpdateError(err) {
  const text = String(err && err.message ? err.message : err)
  if (/404|latest\.yml|releases\.atom|Cannot find/i.test(text)) {
    return 'No se encontraron versiones publicadas. Verifique que el repositorio de GitHub exista, sea público y tenga un Release.'
  }
  if (/ENOTFOUND|ECONN|ETIMEDOUT|net::|network/i.test(text)) {
    return 'No hay conexión con GitHub. Revise su internet e intente de nuevo.'
  }
  return 'No se pudo buscar actualizaciones: ' + text.split(/\r?\n/)[0].slice(0, 140)
}

function setupUpdates() {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking' }))
  autoUpdater.on('update-available', (info) => sendUpdate({ status: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => sendUpdate({ status: 'none' }))
  autoUpdater.on('download-progress', (p) => sendUpdate({ status: 'progress', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => sendUpdate({ status: 'ready', version: info.version }))
  autoUpdater.on('error', (err) => sendUpdate({ status: 'error', message: friendlyUpdateError(err) }))
}

function checkUpdates() {
  if (!app.isPackaged) {
    sendUpdate({ status: 'error', message: 'Las actualizaciones solo funcionan en la versión instalada' })
    return
  }
  autoUpdater.checkForUpdates().catch(() => undefined)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'On Time PDF',
    backgroundColor: '#f3f2ef',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate(macMenu()) : null)
  if (isDev) win.loadURL('http://localhost:5173')
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  win.on('close', (e) => {
    if (session && session.index !== session.saved && !win.forceClose) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Salir sin guardar', 'Cancelar'],
        defaultId: 1,
        cancelId: 1,
        message: 'Hay cambios sin guardar',
        detail: 'Use «Guardar copia» para conservarlos.',
      })
      if (choice === 1) e.preventDefault()
    }
  })
}

ipcMain.handle('doc:open', async (_e, file) => {
  let target = file
  if (!target) {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: pickFilters('pdf') })
    if (res.canceled) return null
    target = res.filePaths[0]
  }
  return openSession(target)
})

ipcMain.handle('app:initial', () => {
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => a.toLowerCase().endsWith('.pdf') && fs.existsSync(a))
  return arg ? path.resolve(arg) : null
})

ipcMain.handle('app:support', () => shell.openExternal(SUPPORT_URL))
ipcMain.handle('app:version', () => app.getVersion())
ipcMain.handle('update:check', () => checkUpdates())
ipcMain.handle('update:download', () => {
  sendUpdate({ status: 'downloading' })
  return autoUpdater.downloadUpdate().catch(() => undefined)
})
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall())

ipcMain.handle('doc:bytes', () => new Uint8Array(fs.readFileSync(currentPath())))

ipcMain.handle('doc:state', () => (session ? stateOf() : null))

ipcMain.handle('doc:op', async (_e, cmd, args) => {
  if (!session) return { ok: false, error: 'No hay documento abierto' }
  const out = snapshot(session.index + 1)
  const result = await runEngine(cmd, { ...args, src: currentPath(), out })
  if (!result.ok) return result
  for (let i = session.index + 2; i <= session.last; i++) fs.rmSync(snapshot(i), { force: true })
  session.index += 1
  session.last = session.index
  session.token = Date.now()
  return { ...result, state: stateOf() }
})

ipcMain.handle('doc:merge', async (_e, files) => {
  if (!session) return { ok: false, error: 'No hay documento abierto' }
  const out = snapshot(session.index + 1)
  const result = await runEngine('merge', { inputs: [currentPath(), ...files], out })
  if (!result.ok) return result
  for (let i = session.index + 2; i <= session.last; i++) fs.rmSync(snapshot(i), { force: true })
  session.index += 1
  session.last = session.index
  session.token = Date.now()
  return { ...result, state: stateOf() }
})

ipcMain.handle('doc:query', (_e, cmd, args) => {
  if (!session) return { ok: false, error: 'No hay documento abierto' }
  return runEngine(cmd, { ...args, src: currentPath() })
})

ipcMain.handle('doc:undo', () => {
  if (session && session.index > 0) {
    session.index -= 1
    session.token = Date.now()
  }
  return session ? stateOf() : null
})

ipcMain.handle('doc:redo', () => {
  if (session && session.index < session.last) {
    session.index += 1
    session.token = Date.now()
  }
  return session ? stateOf() : null
})

ipcMain.handle('doc:saveAs', async () => {
  if (!session) return null
  const base = path.parse(session.original)
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(base.dir, `${base.name} (editado).pdf`),
    filters: pickFilters('pdf'),
  })
  if (res.canceled || !res.filePath) return null
  if (path.resolve(res.filePath) === path.resolve(session.original)) {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Sobrescribir el original', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      message: 'Va a sobrescribir el archivo original',
    })
    if (choice === 1) return null
  }
  fs.copyFileSync(currentPath(), res.filePath)
  session.saved = session.index
  return { file: res.filePath, state: stateOf() }
})

ipcMain.handle('doc:export', async (_e, cmd, args) => {
  if (!session) return { ok: false, error: 'No hay documento abierto' }
  const base = path.parse(session.original)
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(base.dir, `${base.name} (extracto).pdf`),
    filters: pickFilters('pdf'),
  })
  if (res.canceled || !res.filePath) return null
  const result = await runEngine(cmd, { ...args, src: currentPath(), out: res.filePath })
  return { ...result, file: res.filePath }
})

ipcMain.handle('doc:split', async (_e, ranges) => {
  if (!session) return { ok: false, error: 'No hay documento abierto' }
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  if (res.canceled) return null
  const base = path.parse(session.original)
  const result = await runEngine('split', { src: currentPath(), outdir: res.filePaths[0], ranges })
  return { ...result, stem: base.name }
})

ipcMain.handle('pick:files', async (_e, kind, multi) => {
  const res = await dialog.showOpenDialog(win, {
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: pickFilters(kind),
  })
  return res.canceled ? [] : res.filePaths
})

app.whenReady().then(() => {
  createWindow()
  setupUpdates()
  win.webContents.once('did-finish-load', () => {
    if (app.isPackaged) setTimeout(checkUpdates, 4000)
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (session) {
    fs.rmSync(session.dir, { recursive: true, force: true })
    session = null
  }
  if (process.platform !== 'darwin') app.quit()
})
