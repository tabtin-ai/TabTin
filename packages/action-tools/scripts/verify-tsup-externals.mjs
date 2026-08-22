#!/usr/bin/env node
/**
 * verify-tsup-externals — defend against the "@vscode/ripgrep" class of bug.
 *
 * 防御目标：tsup/esbuild 把"含原生二进制 / 用 __dirname 算二进制路径"的
 * npm 包内联进 dist chunk，导致运行时 `__dirname` 被替换成 dist 目录，
 * `path.join(__dirname, '../bin/X')` 解析到不存在的位置。
 *
 * 触发场景的真实案例：@vscode/ripgrep 的 lib/index.js 是
 * `module.exports.rgPath = path.join(__dirname, '../bin/rg...')`。tsup 默认
 * inline 进 dist chunk 后 __dirname 错位，rgPath 永远不存在，grep_search
 * 兜底 fall through 到 `which rg`，受限 PATH 下整条链路死锁。
 *
 * 算法：
 *   1. 读 dist/*.js 所有 chunk
 *   2. 解析 esbuild 注入的 `__commonJS` shim 注释行（形如
 *      `// ../../node_modules/.pnpm/<scope>+<name>@<ver>/node_modules/<scope>/<name>/lib/index.js`），
 *      提取被 inline 的 npm 包名
 *   3. 对每个被 inline 的包，检查其物理特征：
 *      - package.json 含 `gypfile: true` 或 `binary` 字段 → native build
 *      - scripts.postinstall 含 download/extract/prebuild-install/node-gyp/node-pre-gyp → 下载二进制
 *      - 包目录含 `*.node`（编译产物）或 `bin/` 下非 JS 文件（绑定预编译二进制）
 *   4. 命中任一特征 → 报错"X 必须 external"，exit 1
 *
 * 加到 build 链：`tsup && node scripts/verify-tsup-externals.mjs && ...`。
 */

import { promises as fs } from 'node:fs'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.resolve(__dirname, '..')
const distRoot = path.join(packageRoot, 'dist')

if (!existsSync(distRoot)) {
  console.error('[verify-tsup-externals] dist/ not found. Run `pnpm -C packages/action-tools build` first.')
  process.exit(1)
}

const requireFromPkg = createRequire(path.join(packageRoot, 'package.json'))

// ─── 1. 收集 dist 里所有被 inline 的 npm 包 ───────────────────────

/**
 * esbuild commonJS shim 形态（同 dist 里实测）：
 *
 *   // ../../node_modules/.pnpm/@vscode+ripgrep@1.17.1/node_modules/@vscode/ripgrep/lib/index.js
 *   var require_lib = __commonJS({
 *     "../../node_modules/.pnpm/@vscode+ripgrep@1.17.1/node_modules/@vscode/ripgrep/lib/index.js"(exports, module) {
 *       ...
 *     }
 *   });
 *
 * 关键 token：注释行里的 npm 包名段（含 scope 时形如 `@vscode/ripgrep`）。
 *
 * 我们用注释里 `node_modules/<scope>?/<name>/` pattern 提取包名（最后一个
 * node_modules 之后的路径段）。esbuild 不同版本注释格式略有差异，统一从
 * `node_modules` 之后的路径片段判定包名。
 */
const NM_PATTERN = /node_modules\/((?:@[\w-]+\/)?[\w.-]+)\//g

async function collectInlinedPackages() {
  const chunks = (await fs.readdir(distRoot)).filter(f => f.endsWith('.js'))
  const inlined = new Map() // pkgName -> { chunkFile, samplePath }

  for (const chunk of chunks) {
    const chunkPath = path.join(distRoot, chunk)
    const stat = await fs.stat(chunkPath)
    if (!stat.isFile()) continue

    const content = await fs.readFile(chunkPath, 'utf8')

    // 只看 __commonJS 上下文 —— 普通 import 路径不会被 inline 进 shim
    if (!content.includes('__commonJS')) continue

    // 扫描注释行：esbuild 在每个 inline 模块前注释源路径
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 注释行 + 紧跟 __commonJS 调用 → 这是 inline 标志
      if (!line.startsWith('// ')) continue
      const next = lines[i + 1]
      if (!next?.includes('__commonJS')) continue

      const matches = [...line.matchAll(NM_PATTERN)]
      if (matches.length === 0) continue
      // 取最后一个 node_modules 之后的包名（最深层 = 实际被 inline 的包）
      const pkgName = matches[matches.length - 1][1]
      if (!inlined.has(pkgName)) {
        inlined.set(pkgName, { chunkFile: chunk, samplePath: line.slice(3).trim() })
      }
    }
  }

  return inlined
}

// ─── 2. 检查包是否含 native binary 特征 ────────────────────────────

function hasNativeBinaryFeatures(pkgName) {
  const reasons = []

  // 解析包的 package.json
  let pkgJsonPath
  try {
    pkgJsonPath = requireFromPkg.resolve(`${pkgName}/package.json`)
  } catch {
    // 有可能 dist 里 inline 了 monorepo 内部包（workspace:*），无 package.json
    // 解析 path 时报错 → 跳过
    return null
  }

  let pkgJson
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  } catch (err) {
    return { reasons: [`failed to read package.json: ${err.message}`] }
  }

  if (pkgJson.gypfile === true) reasons.push('package.json has gypfile:true (node-gyp build)')
  if (pkgJson.binary && typeof pkgJson.binary === 'object') reasons.push('package.json has binary field (prebuild-install / node-pre-gyp)')

  const post = pkgJson.scripts?.postinstall ?? ''
  if (typeof post === 'string' && /node-gyp|prebuild-install|node-pre-gyp|electron-rebuild|download.*binary|extract.*binary|nan-install/i.test(post)) {
    reasons.push(`postinstall script downloads/builds binary: "${post.slice(0, 80)}"`)
  }

  // 物理扫描：包目录含 .node 文件（已编译 native bindings）
  const pkgDir = path.dirname(pkgJsonPath)
  try {
    const dotNodeFound = scanForNodeFiles(pkgDir, 3)
    if (dotNodeFound) reasons.push(`contains compiled native binding: ${dotNodeFound}`)
  } catch { /* ignore traversal errors */ }

  // 物理扫描：包 bin/ 目录含非 JS 文件（典型预编译二进制布局，如 @vscode/ripgrep）
  const binDir = path.join(pkgDir, 'bin')
  if (existsSync(binDir)) {
    try {
      const entries = readdirSync(binDir)
      const nonJs = entries.filter(e => {
        const full = path.join(binDir, e)
        try {
          const st = statSync(full)
          if (!st.isFile()) return false
          // 排除明显的 JS 文件
          if (/\.(m?js|cjs|ts|json|md)$/.test(e)) return false
          return true
        } catch { return false }
      })
      if (nonJs.length > 0) {
        reasons.push(`bin/ directory contains non-JS prebuilt binaries: ${nonJs.slice(0, 3).join(', ')}${nonJs.length > 3 ? '...' : ''}`)
      }
    } catch { /* ignore */ }
  }

  return reasons.length > 0 ? { reasons } : null
}

/**
 * 递归扫描目录，找 *.node 文件。命中即返回相对路径，未命中返回 null。
 * maxDepth 防止扫到极深的 node_modules 嵌套。
 */
function scanForNodeFiles(dir, maxDepth) {
  if (maxDepth <= 0) return null
  let entries
  try { entries = readdirSync(dir) } catch { return null }
  for (const entry of entries) {
    const full = path.join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isFile() && entry.endsWith('.node')) return path.relative(dir, full)
    if (st.isDirectory() && entry !== 'node_modules' && entry !== '.git') {
      const found = scanForNodeFiles(full, maxDepth - 1)
      if (found) return path.join(entry, found)
    }
  }
  return null
}

// ─── 3. 主流程 ───────────────────────────────────────────────────

async function main() {
  console.log('[verify-tsup-externals] scanning dist/ for inlined packages...')
  const inlined = await collectInlinedPackages()
  console.log(`[verify-tsup-externals] found ${inlined.size} packages inlined into dist chunks`)

  const offenders = []
  for (const [pkgName, info] of inlined) {
    // 跳过 monorepo 内部包（@tabtin/*、@tabtinapp/* 等本仓 workspace）和 node 内置
    if (pkgName.startsWith('@tabtin/') || pkgName.startsWith('@tabtinapp/')) continue

    const result = hasNativeBinaryFeatures(pkgName)
    if (result?.reasons?.length > 0) {
      offenders.push({ pkgName, ...info, reasons: result.reasons })
    }
  }

  if (offenders.length === 0) {
    console.log('[verify-tsup-externals] OK — no native-binary packages were inlined into dist')
    return
  }

  console.error('\n[verify-tsup-externals] FAIL — the following packages contain native binaries / use __dirname for binary paths\n  but were inlined into dist chunks. They MUST be added to tsup.config.ts `external` array:\n')
  for (const o of offenders) {
    console.error(`  ✗ ${o.pkgName}`)
    console.error(`      inlined in: dist/${o.chunkFile}`)
    console.error(`      source: ${o.samplePath}`)
    for (const r of o.reasons) console.error(`      reason: ${r}`)
    console.error('')
  }
  console.error('Fix: edit packages/action-tools/tsup.config.ts and add the package(s) to `external: [...]`, then rebuild.')
  console.error('Background: docs/agent-runtime/dogfood-debugging-handbook.md §5.1.1 explains the @vscode/ripgrep precedent.\n')
  process.exit(1)
}

main().catch(err => {
  console.error('[verify-tsup-externals] unexpected error:', err)
  process.exit(2)
})
