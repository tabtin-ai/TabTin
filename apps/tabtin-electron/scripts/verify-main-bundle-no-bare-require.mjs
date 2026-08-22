#!/usr/bin/env node
/**
 * verify-main-bundle-no-bare-require — packaged ESM 主进程裸 require( 守卫
 *
 * 背景（2026-05-07）：electron-vite 把主进程打成 `format='es'` 纯 ESM bundle
 * （out/main/*.mjs），顶部既无 esbuild `__require` polyfill 也无 `typeof require`
 * 守卫。源码里只要写了裸 `require(...)`，bundle 会原样保留字面量 → 运行时
 * `ReferenceError: require is not defined`，被 IPC handler 吞成 `Error
 * occurred in handler for 'checkpoint:init'` 之类的链路级 P0。
 *
 * 历史现场：W7c 的 `getDefaultPathAccessChecker` 第 379 行 `require('electron')`
 * 让 packaged 客户端 checkpoint 整链不工作；同款雷同时藏在 MarketplaceAppInstaller
 * 第 316 / 327 行 `require('fs').readFileSync(...)`。
 *
 * 修法范式：源文件顶部加
 *   import { createRequire } from 'node:module'
 *   const require = createRequire(import.meta.url)
 * esbuild 会把这个本地 const 重命名为 `require$1` 之类形式，调用变成
 * `require$1('electron')`——不属于"裸"调用，packaged ESM 安全。
 *
 * 本脚本扫 out/main/*.mjs 的所有行，命中不带命名空间前缀的 `require(` 即报警。
 * regex 用 negative lookbehind `(?<![\w$])`：
 *   - 命中：`require("electron")`、`= require('foo')`、` require( ` 等
 *   - 不命中：`require$1(...)` / `require$2(...)`（esbuild 重命名形式 — 安全）
 *
 * 排除两类已知非运行时命中（避免误伤）：
 *   1. 注释行：trim 后以 `*`、`//`、`/*` 开头（JSDoc 文档示例不会执行）
 *   2. backtick 模板字符串内部：典型场景是 `tin-bridge.ts:generateTinPreloadScript`
 *      把 preload 脚本以模板字符串形式 ship 到 BrowserView 的 CJS 上下文，
 *      字符串本身只是数据，不在主进程 ESM 执行——简单跟踪 backtick 计数判定。
 *      `${...}` 内嵌表达式中的 require( 是 edge case，当前 bundle 未出现，先不处理。
 *
 * 使用方式：
 *   - 手动跑：`node apps/tabtin-electron/scripts/verify-main-bundle-no-bare-require.mjs`
 *   - 推荐 CI / build 后跑（暂未挂到 prebuild 链路，先按需调用避免误伤未知场景）
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_MAIN = join(here, '..', 'out', 'main')

if (!existsSync(OUT_MAIN)) {
  console.error(
    `[verify-main-bundle] ${OUT_MAIN} 不存在；先跑 \`pnpm --filter tabtin-electron build\`。`,
  )
  process.exit(1)
}

const BARE_REQUIRE = /(?<![\w$])require\s*\(/
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/

function isInsideTemplateAt(text, lineStartOffset) {
  // 简单计数：扫到当前行起始位置之前，未转义的 backtick 数量为奇数 → 在模板内
  // 不处理 ${} 嵌套深度；当前 bundle 没有 ${} 内 require 的场景。
  let count = 0
  for (let i = 0; i < lineStartOffset; i++) {
    const ch = text[i]
    if (ch === '`' && text[i - 1] !== '\\') count++
  }
  return count % 2 === 1
}

const violations = []
for (const name of readdirSync(OUT_MAIN)) {
  if (!name.endsWith('.mjs')) continue
  const full = join(OUT_MAIN, name)
  if (!statSync(full).isFile()) continue
  const text = readFileSync(full, 'utf-8')
  const lines = text.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const lineStart = offset
    offset += line.length + 1 // +1 for stripped '\n'
    if (!BARE_REQUIRE.test(line)) continue
    if (COMMENT_LINE.test(line)) continue
    if (isInsideTemplateAt(text, lineStart)) continue
    violations.push({
      file: name,
      line: i + 1,
      snippet: line.trim().slice(0, 200),
    })
  }
}

if (violations.length > 0) {
  console.error(
    '[verify-main-bundle] ❌ 发现裸 require( 调用（packaged ESM 运行时会 ReferenceError）：',
  )
  for (const v of violations) {
    console.error(`  out/main/${v.file}:${v.line}  ${v.snippet}`)
  }
  console.error('')
  console.error('修复指引：定位源文件，顶部加')
  console.error("  import { createRequire } from 'node:module'")
  console.error('  const require = createRequire(import.meta.url)')
  console.error('范式见 src/main/security/path-access-checker.ts。')
  process.exit(1)
}

console.log(
  `[verify-main-bundle] ✅ ${OUT_MAIN}: no bare \`require(\` in ESM chunks`,
)
