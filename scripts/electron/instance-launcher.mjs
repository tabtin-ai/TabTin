#!/usr/bin/env node
/** 保持 Electron 的父进程存活，供开发态 dev-parent-watchdog 监督。 */
import { spawn } from 'node:child_process'

const [electronBinary, appPath] = process.argv.slice(2)
if (!electronBinary || !appPath) {
  console.error('用法: instance-launcher.mjs <electron-binary> <app-path>')
  process.exit(1)
}

const child = spawn(electronBinary, [appPath], {
  env: process.env,
  // 后台启动第二实例时不继承 stdin，避免 Electron/Chromium 挂起前台进程组。
  stdio: ['ignore', 'inherit', 'inherit'],
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error(`[electron-instance-launcher] 启动失败: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
