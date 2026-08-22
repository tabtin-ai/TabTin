#!/usr/bin/env node
/**
 * prepare-dev-runtime.mjs — assets needed before Electron dev.
 *
 * Renderer/main/preload workspace JS resolves through package `source` export
 * conditions, so plain `pnpm dev` reads each `@tabtin/*` package's `src/*.ts`
 * directly — dev *runtime* is correct without a dist build.
 *
 * But dev also runs the main-process type-checker inline: electron.vite.config.ts
 * mounts `vite-plugin-checker` against `tsconfig.main.json`, which deliberately
 * does NOT enable the `source` condition (it can't — tsc following `source` into
 * e.g. a package's internal `@/*` alias; see the comment in
 * tsconfig.main.json). So the checker resolves every `@tabtin/*` import via the
 * `types` condition → `dist/*.d.ts`. Any stale workspace dist therefore makes the
 * dev terminal cry false "no exported member / property does not exist" errors.
 *
 * We must not hand-maintain a per-package allowlist of which dist to refresh
 * (it silently drifts from the real import graph — each missed package resurfaces
 * the same bug). Instead delegate to scripts/predev-build.mjs, which derives the
 * build set from tabtin-electron's package.json `workspace:*` dependency closure,
 * topo-sorts it, and skips packages whose source fingerprint is unchanged — so a
 * warm restart rebuilds nothing and stays fast. Run via run-predev-build-with-lock
 * (`build:workspace`) so it shares the workspace build lock with tabtin-web.
 *
 * This script additionally keeps non-TS dev runtime artifacts fresh that aren't
 * npm-build outputs (tabtin-filegen PyInstaller binary), plus targeted guards for
 * artifacts whose presence the dependency-graph fingerprint can't assert directly
 * (smartsheet-ui CSS bundle, Go `tabtin` CLI binary).
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')
const PNPM = 'pnpm'
const require = createRequire(import.meta.url)

function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return null
  }
}

function newestMtimeUnder(dir) {
  let max = null
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      const m = mtimeMs(full)
      if (m != null && (max == null || m > max)) max = m
    }
  }
  return max
}

function run(command, args, options = {}) {
  const useShell = process.platform === 'win32' && !path.isAbsolute(command)
  // Bare .cmd/.exe commands like pnpm still need a shell on Windows, but
  // absolute paths such as process.execPath may contain spaces.
  // shell:true 时命令字符串会交给 cmd.exe 解析，含空格路径必须加引号。
  const shellSafeCommand = useShell && command.includes(' ') && !command.startsWith('"')
    ? `"${command}"`
    : command
  const result = spawnSync(shellSafeCommand, args, {
    cwd: options.cwd ?? ROOT,
    stdio: 'inherit',
    env: options.env ?? process.env,
    shell: useShell,
  })
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1)
  }
}

function electronBinaryReady(packageDir) {
  const pathFile = path.join(packageDir, 'path.txt')
  try {
    const relativeExecutable = fs.readFileSync(pathFile, 'utf8')
    const normalizedExecutable = relativeExecutable.trim()
    if (!normalizedExecutable || !fs.existsSync(path.join(packageDir, 'dist', normalizedExecutable))) {
      return false
    }
    if (relativeExecutable !== normalizedExecutable) {
      fs.writeFileSync(pathFile, normalizedExecutable)
    }
    return true
  } catch {
    return false
  }
}

function ensureElectronBinary() {
  const packageFile = require.resolve('electron/package.json')
  const packageDir = path.dirname(packageFile)
  if (electronBinaryReady(packageDir)) return

  console.log('  📦 Electron 二进制不存在，执行官方 install script...')
  const installScript = path.join(packageDir, 'install.js')
  const explicitMirror = process.env.ELECTRON_MIRROR?.trim()
  if (explicitMirror) {
    run(process.execPath, [installScript], { cwd: packageDir })
    if (!electronBinaryReady(packageDir)) {
      throw new Error('Electron install script exited without installing its binary')
    }
    return
  }

  const official = spawnSync(process.execPath, [installScript], {
    cwd: packageDir,
    stdio: 'inherit',
    env: process.env,
    timeout: 45_000,
  })
  if (official.status === 0 && electronBinaryReady(packageDir)) return

  console.log('  ↪ 官方 Electron 下载超时，切换国内镜像重试...')
  run(process.execPath, [installScript], {
    cwd: packageDir,
    env: {
      ...process.env,
      ELECTRON_MIRROR: 'https://cdn.npmmirror.com/binaries/electron/',
    },
  })
  if (!electronBinaryReady(packageDir)) {
    throw new Error('Electron mirror install exited without installing its binary')
  }
}

function ensureSkillBundles() {
  const appsRoot = path.join(ROOT, 'packages', 'apps')
  if (!fs.existsSync(appsRoot)) return
  const hydrator = path.join(ROOT, 'scripts', 'skill-bundles.mjs')
  if (!fs.existsSync(hydrator)) {
    console.log('  ⏭  跳过（当前源码快照未提供 Skill Bundle hydrator）')
    return
  }
  console.log('  📦 校验并补齐 Agent Skill Bundle')
  run(process.execPath, [
    hydrator,
    'hydrate-all',
    '--apps-root',
    appsRoot,
    '--bundles-root',
    path.join(ROOT, 'packages', 'skill-bundles'),
  ])
}

// 工作区 dist 新鲜度：交给按真实依赖图驱动的增量构建器，而不是手写包清单。
// 见文件头注释——main typecheck（vite-plugin-checker / tsconfig.main.json）按 types
// 条件读各 @tabtin/* 包 dist/*.d.ts，任一被间接 import 的 workspace 包 dist 过期就会
// 在 dev 终端报假错。predev-build.mjs 从 tabtin-electron 的 package.json workspace:*
// 依赖闭包推导构建集、拓扑排序、按源指纹增量跳过已最新包（warm restart 零重建）；
// 经 run-predev-build-with-lock.mjs 持锁，与 tabtin-web 共享 workspace 构建锁。
function ensureWorkspaceDist() {
  console.log('  🧩 校验 workspace 依赖 dist 新鲜度（按 package.json 依赖图增量构建）')
  run(process.execPath, [path.join(ROOT, 'scripts', 'electron', 'run-predev-build-with-lock.mjs')])
}

function ensureSmartsheetStyles() {
  const pkgDir = path.join(ROOT, 'packages', 'smartsheet-ui')
  const cssFile = path.join(pkgDir, 'dist', 'smartsheet-ui.css')
  const cssMs = mtimeMs(cssFile)
  const srcMax = newestMtimeUnder(path.join(pkgDir, 'src'))
  const configMax = Math.max(
    mtimeMs(path.join(pkgDir, 'package.json')) ?? 0,
    mtimeMs(path.join(pkgDir, 'vite.config.ts')) ?? 0,
    mtimeMs(path.join(pkgDir, 'tsconfig.json')) ?? 0,
  )
  const newestInput = Math.max(srcMax ?? 0, configMax)
  if (cssMs != null && cssMs >= newestInput) {
    console.log('  ⏭  跳过（smartsheet-ui styles 已最新）')
    return
  }

  console.log('  🎨 构建 smartsheet-ui styles')
  run(PNPM, ['--filter', '@tabtin/smartsheet-ui', 'build'])
}

function ensureGoCli() {
  const cliDir = path.join(ROOT, 'packages', 'tabtin-cli-go')
  const binaryName = process.platform === 'win32' ? 'tabtin.exe' : 'tabtin'
  const binaryRel = path.join('dist', binaryName)
  const binary = path.join(cliDir, binaryRel)
  if (!fs.existsSync(cliDir)) return

  if (fs.existsSync(binary)) {
    const binMs = mtimeMs(binary)
    const srcMax = Math.max(
      newestMtimeUnder(path.join(cliDir, 'cmd')) ?? 0,
      newestMtimeUnder(path.join(cliDir, 'internal')) ?? 0,
      mtimeMs(path.join(cliDir, 'main.go')) ?? 0,
      mtimeMs(path.join(cliDir, 'go.mod')) ?? 0,
      mtimeMs(path.join(cliDir, 'go.sum')) ?? 0,
    )
    if (binMs != null && srcMax <= binMs) {
      console.log(`  ⏭  跳过（${binaryRel} 已最新）`)
      return
    }
    console.log(`  📝 检测到 Go 源码变更，重 build ${binaryRel}`)
  } else {
    console.log(`  🔨 build ${binaryRel}`)
  }

  fs.mkdirSync(path.join(cliDir, 'dist'), { recursive: true })
  run('go', ['build', '-o', binaryRel, '.'], { cwd: cliDir })
  console.log(`  ✅ ${binaryRel} rebuilt`)
}

// tabtin-filegen（PyInstaller 自包含二进制，客户端免装 Python）：被 cli-server.ts
// 注入到 Agent shell PATH，供 `tabtin file create` 代理调用。best-effort——文件生成
// 是可选附加能力，缺 python3 / 打包失败只 warn，不中断 dev 启动。
function darwinFilegenMatchesHost(binary) {
  if (process.platform !== 'darwin') return true
  const probed = spawnSync('file', ['-b', binary], { encoding: 'utf8' })
  const info = probed.stdout || ''
  if (info.includes('universal')) return true
  const token = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  return info.includes(token)
}

function ensureFileGenCli() {
  const pkgDir = path.join(ROOT, 'packages', 'tabtin-filegen-python')
  const binaryName = process.platform === 'win32' ? 'tabtin-filegen.exe' : 'tabtin-filegen'
  const binaryRel = path.join('dist', binaryName)
  const binary = path.join(pkgDir, binaryRel)
  if (!fs.existsSync(pkgDir)) return

  if (fs.existsSync(binary)) {
    const binMs = mtimeMs(binary)
    const srcMax = Math.max(
      newestMtimeUnder(path.join(pkgDir, 'src')) ?? 0,
      mtimeMs(path.join(pkgDir, 'pyproject.toml')) ?? 0,
      mtimeMs(path.join(pkgDir, 'build.sh')) ?? 0,
    )
    const archOk = darwinFilegenMatchesHost(binary)
    if (binMs != null && srcMax <= binMs && archOk) {
      console.log(`  ⏭  跳过（${binaryRel} 已最新）`)
      return
    }
    if (!archOk) {
      console.log(`  📝 检测到 filegen 架构与本机不符，重 build ${binaryRel}`)
    } else {
      console.log(`  📝 检测到 filegen 源码变更，重 build ${binaryRel}`)
    }
  } else {
    console.log(`  🔨 build ${binaryRel}`)
  }

  if (process.platform === 'win32') {
    console.warn('  ⚠️  Windows 下请手动运行 packages/tabtin-filegen-python/build.sh，已跳过 tabtin-filegen 构建')
    return
  }
  const py = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  if ((py.status ?? 1) !== 0) {
    console.warn('  ⚠️  未找到 python3，跳过 tabtin-filegen 构建（`tabtin file create` 暂不可用）')
    return
  }
  const r = spawnSync('bash', ['build.sh'], { cwd: pkgDir, stdio: 'inherit', env: process.env })
  if ((r.status ?? 1) !== 0) {
    console.warn('  ⚠️  tabtin-filegen 构建失败（不阻断 dev）')
    return
  }
  console.log(`  ✅ ${binaryRel} rebuilt`)
}

function ensureDesktopRuntimes() {
  console.log('  📦 补齐启动所需的 Python runtime（Office runtime 按需显式获取）')
  if (process.platform === 'win32') {
    const ensureBat = path.join(ROOT, 'scripts', 'electron', 'runtime', '_ensure-desktop-runtimes.bat')
    if (!fs.existsSync(ensureBat)) return
    run('cmd.exe', ['/d', '/s', '/c', ensureBat])
    return
  }
  const ensureScript = path.join(ROOT, 'scripts', 'electron', 'runtime', '_ensure-desktop-runtimes.sh')
  if (!fs.existsSync(ensureScript)) return
  run('bash', [ensureScript])
}

console.log('⏳ 准备 Electron dev runtime 产物')
ensureElectronBinary()
ensureSkillBundles()
ensureWorkspaceDist()
ensureSmartsheetStyles()
ensureGoCli()
ensureFileGenCli()
ensureDesktopRuntimes()
console.log('✅ Electron dev runtime 产物已就绪')
