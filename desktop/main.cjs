// ai3dc-chat: Electron はウィンドウとプロセス管理だけを担当する。
// 同梱の node.exe で Next.js standalone サーバ（AITuberKit）を、同梱の ai3dc-bridge.exe で会話ブリッジを起動し、
// 両方が上がったら BrowserWindow で開く。終了時に両方を落とす。
const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('child_process')
const http = require('http')
const path = require('path')
const fs = require('fs')

const APP_PORT = Number(process.env.AI3DC_APP_PORT || 18300)
const BRIDGE_PORT = Number(process.env.AI3DC_BRIDGE_PORT || 18301)
const isPackaged = app.isPackaged
const resourcesDir = isPackaged
  ? process.resourcesPath
  : path.join(__dirname, 'resources')

const children = []

function log(...args) {
  console.log('[ai3dc-chat]', ...args)
}

function spawnChild(name, exe, args, opts) {
  const child = spawn(exe, args, { stdio: 'inherit', windowsHide: true, ...opts })
  child.on('exit', (code) => log(`${name} exited (${code})`))
  children.push(child)
  return child
}

function startServer() {
  const serverDir = path.join(resourcesDir, 'app-server')
  const nodeExe = path.join(resourcesDir, 'node', 'node.exe')
  const serverJs = path.join(serverDir, 'server.js')
  for (const p of [nodeExe, serverJs]) {
    if (!fs.existsSync(p)) throw new Error(`missing: ${p}`)
  }
  return spawnChild('next', nodeExe, [serverJs], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      HOSTNAME: '127.0.0.1',
      NODE_ENV: 'production',
    },
  })
}

function startBridge() {
  const bridgeExe = path.join(resourcesDir, 'bridge', 'ai3dc-bridge.exe')
  if (!fs.existsSync(bridgeExe)) throw new Error(`missing: ${bridgeExe}`)
  return spawnChild('bridge', bridgeExe, [], {
    cwd: path.dirname(bridgeExe),
    env: { ...process.env, AI3DC_BRIDGE_PORT: String(BRIDGE_PORT), PYTHONUTF8: '1' },
  })
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`timeout waiting for ${url}`))
        else setTimeout(tick, 500)
      })
    }
    tick()
  })
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'ai3dc-chat',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  await win.loadURL(`http://127.0.0.1:${APP_PORT}/`)
}

function killChildren() {
  for (const c of children) {
    if (c.exitCode === null) {
      try {
        // Windows では子の子（uvicorn 等）ごと落とす
        spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true })
      } catch (e) {
        log('kill failed', e)
      }
    }
  }
}

app.whenReady().then(async () => {
  try {
    startBridge()
    startServer()
    await waitForHttp(`http://127.0.0.1:${APP_PORT}/`, 60000)
    await createWindow()
  } catch (e) {
    dialog.showErrorBox('ai3dc-chat 起動失敗', String(e && e.stack ? e.stack : e))
    killChildren()
    app.quit()
  }
})

app.on('window-all-closed', () => {
  killChildren()
  app.quit()
})
app.on('before-quit', killChildren)
