// 渲染进程与主进程之间的最小安全桥(contextIsolation + sandbox 下)。
// 只暴露「触发检查更新」这一个能力,不开放任意 ipc。用 .cjs 强制 CommonJS
// (package.json 是 type:module,preload 在 sandbox 下必须是 CJS)。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('mrUpdates', {
  // 触发一次手动检查(非 silent):结果由主进程用原生对话框呈现。带上 app 内选择的语言。
  check: (locale) => ipcRenderer.invoke('updates:check', locale),
  // 把当前 app 语言告诉主进程,让启动时的静默检查弹窗也用对的语言。
  setLocale: (locale) => ipcRenderer.send('updates:locale', locale),
})
