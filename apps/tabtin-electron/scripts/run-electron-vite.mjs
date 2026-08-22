#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectGitBuildInfoEnv } from './resolve-git-build-info.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const electronVitePackageJson = require.resolve('electron-vite/package.json')
const electronViteCli = join(dirname(electronVitePackageJson), 'bin', 'electron-vite.js')

const DEFAULT_MAX_OLD_SPACE_SIZE_MB = 8192
const requestedLimit = process.env.TABTIN_ELECTRON_BUILD_MAX_OLD_SPACE_SIZE?.trim()
const parsedLimit = requestedLimit ? Number.parseInt(requestedLimit, 10) : Number.NaN
const maxOldSpaceSize = Number.isFinite(parsedLimit) && parsedLimit > 0
  ? parsedLimit
  : DEFAULT_MAX_OLD_SPACE_SIZE_MB

// 根据 TABTIN_BUILD_PROFILE 自动注入 vite --mode 参数 ——
//
// 历史 bug：vite build 默认 mode='production'，会自动加载 .env.production，
// 优先级压过 .env.<profile> 里的 VITE_API_BASE_URL / VITE_APP_VERSION 等关键变量。
// 结果：local profile build 出来的代码偷偷指向生产服务器（重大故障）。
//
// vite mode 不接受 'local'（保留给 .env.local 后缀冲突），所以做一次映射：
//   profile='local' → vite mode='localdev'（文件 .env.localdev）
//   其他 profile → 透传（如 community → mode=community）
//
// vite.config.ts 的 envFileLoaded 段也按这个 viteMode 找对应 .env.<viteMode>。
// NODE_ENV 不变（仍 'production'），import.meta.env.PROD 仍 = true（vite 文档：
// mode 与 NODE_ENV 解耦）。
const PROFILE_TO_VITE_MODE = {
  local: 'localdev',
}
const profile = process.env.TABTIN_BUILD_PROFILE?.trim()
const passthroughArgs = process.argv.slice(2)
const hasModeArg = passthroughArgs.some(arg => arg === '--mode' || arg.startsWith('--mode='))
const viteMode = profile ? (PROFILE_TO_VITE_MODE[profile] ?? profile) : null
const modeArgs = viteMode && !hasModeArg ? ['--mode', viteMode] : []
if (viteMode) {
  process.env.TABTIN_VITE_MODE = viteMode
}

// 从 Electron package.json 读取默认版本号写入 process.env.VITE_APP_VERSION ——
//
// vite 的 loadEnv 优先级：process.env > .env.<mode>.local > .env.<mode> > .env
// 所以这里 force overwrite process.env 后，vite 在 build renderer 时
// import.meta.env.VITE_APP_VERSION 会拿到我们注入的版本，errorReporter 上报的
// app_version 与 sourcemap 入库版本严格对齐。
//
// 显式 export VITE_APP_VERSION（如 CI override）优先级最高，不被覆盖。
if (!process.env.VITE_APP_VERSION) {
  const appPackage = require('../package.json')
  process.env.VITE_APP_VERSION = appPackage.version
  console.log(`[run-electron-vite] 注入 VITE_APP_VERSION="${appPackage.version}"`)
}

// 诊断包 meta.json 需要 git commit/branch：构建期注入，显式 env 优先。
injectGitBuildInfoEnv()

// Renderer build currently exceeds Node's default heap during chunk rendering.
const commandArgs = [
  `--max-old-space-size=${maxOldSpaceSize}`,
  electronViteCli,
  ...passthroughArgs,
  ...modeArgs,
]

const result = spawnSync(process.execPath, commandArgs, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
})

if (typeof result.status === 'number') {
  process.exit(result.status)
}

if (result.error) {
  console.error('[run-electron-vite] electron-vite 启动失败:', result.error)
}

if (result.signal) {
  console.error(
    `[run-electron-vite] electron-vite 被信号 ${result.signal} 终止` +
      (result.signal === 'SIGKILL'
        ? '（常见于内存不足，或与 pnpm dev / 另一路打包并发）'
        : ''),
  )
}

process.exit(1)
