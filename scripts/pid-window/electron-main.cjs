// pid-window 探针的 Electron 替身:开一个窗口加载探针服务器上的靶子页(页面自己把事件报回服务器)。
// 用法:Electron electron-main.cjs <url> <x,y,w,h>(全局点、左上角原点)。不抢前台:showInactive。
const { app, BrowserWindow } = require('electron')
const [url, frame] = process.argv.slice(-2)
app.whenReady().then(() => {
  const [x, y, width, height] = frame.split(',').map(Number)
  const win = new BrowserWindow({ x, y, width, height, show: false, title: 'pid-window probe (Electron)' })
  win.loadURL(url)
  win.once('ready-to-show', () => win.showInactive())
})
