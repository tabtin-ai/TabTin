#!/usr/bin/env node
/**
 * 在 Electron dev 编译产物更新时，重启隔离的第二个 Electron 实例。
 *
 * Renderer 的 HMR 会由同一个 Vite 服务同步到两个窗口；这里只监听 main / preload
 * 产物，以便这些不能靠 HMR 生效的改动也无需手动重开 IM 测试端。
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'

const [electronBinary, appPath, outputDir] = process.argv.slice(2)
if (!electronBinary || !appPath || !outputDir) {
  console.error('用法: second-instance-supervisor.mjs <electron-binary> <app-path> <out-dir>')
  process.exit(1)
}

const watchedDirectories = [path.join(outputDir, 'main'), path.join(outputDir, 'preload')]
const restartDelayMs = 500
let child
let restartTimer
let shuttingDown = false
let restartRequested = false

function startElectron() {
  child = spawn(electronBinary, [appPath], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  child.on('error', (error) => {
    console.error(`[electron-second-instance] 启动失败: ${error.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    child = undefined
    if (restartRequested && !shuttingDown) {
      restartRequested = false
      startElectron()
      return
    }
    if (!shuttingDown) {
      console.log(`[electron-second-instance] 已退出（${signal ?? code ?? 0}）；停止监督`)
      process.exit(code ?? (signal ? 1 : 0))
    }
  })
}

function restartElectron() {
  if (shuttingDown || !child) return

  console.log('[electron-second-instance] 检测到 main/preload 更新，重启第二个 Electron')
  const previous = child
  restartRequested = true
  previous.kill('SIGTERM')

  setTimeout(() => {
    if (child === previous) previous.kill('SIGKILL')
  }, 5_000).unref()
}

function scheduleRestart() {
  if (restartTimer || shuttingDown) return
  restartTimer = setTimeout(() => {
    restartTimer = undefined
    restartElectron()
  }, restartDelayMs)
}

for (const directory of watchedDirectories) {
  try {
    watch(directory, (_eventType, filename) => {
      if (filename && !/\.(?:[cm]?js|node)$/.test(filename)) return
      scheduleRestart()
    })
  } catch (error) {
    console.error(`[electron-second-instance] 无法监听 ${directory}: ${error.message}`)
    process.exit(1)
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shuttingDown = true
    if (restartTimer) clearTimeout(restartTimer)
    if (!child) process.exit(0)
    child.once('exit', () => process.exit(0))
    child.kill(signal)
    setTimeout(() => process.exit(0), 5_000).unref()
  })
}

startElectron()
