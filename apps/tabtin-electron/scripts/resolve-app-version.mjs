/**
 * 应用版本号 SSOT 派生器（single source of truth）。
 *
 * 真源：apps/tabtin-electron/package.json#version
 *
 * 派生规则（与 packaged app 实际 version 严格对齐，错配即反混淆失效）：
 *   - profile=preprod          → "${sourceVersion}-preprod.1"
 *     · 所有预发包统一槽位，主版本号跟随 production 推进
 *   - profile=local            → "${sourceVersion}-local.1"
 *     · 开发者本机测试包；与 preprod 平行独立的 sourcemap 槽位，
 *       让 admindash 能按 app_version 区分"是哪台开发者机器报上来的"
 *       vs "灰度环境真实用户报上来的"，避免本机调试噪声污染预发样本。
 *   - profile=production       → "${sourceVersion}" 原样
 *   - profile=undefined/empty  → "${sourceVersion}" 原样（dev / 手工 build / preview）
 *   - profile=其它             → throw（避免 typo 静默退化成 production）
 *
 * 调用入口：
 *   1. CLI:  `node scripts/resolve-app-version.mjs <profile>`  → stdout = 派生版本号
 *            argv 优先，缺省时回落到 process.env.TABTIN_BUILD_PROFILE
 *   2. JS:   `import { resolveAppVersion, readSourceVersion } from './scripts/resolve-app-version.mjs'`
 *
 * 三处消费方（全部走同一份派生规则）：
 *   - scripts/build-packaged-app.sh 顶部 RESOLVED_APP_VERSION（CLI 调用）
 *   - electron.vite.config.ts fallback（直接 import，覆盖 `pnpm build` 不经 build script 的场景）
 *   - scripts/upload-sourcemaps.sh fallback（CLI 调用，让 TABTIN_BUILD_PROFILE 设置时拿到正确派生值）
 *
 * ⚠ 修改派生规则前请确认：admindash 服务端按 app_version 字符串等值精确匹配
 *   sourcemap，任何派生规则漂移都会让历史 sourcemap 反混淆失效。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

// __dirname 经 fileURLToPath(import.meta.url) 计算——Node 默认 resolve symlink，
// 即使 helper 经 node_modules/.bin/... symlink 调用，仍指向真实物理位置
// `apps/tabtin-electron/scripts/`。把 helper 复制到别处会读错 package.json。
const __dirname = dirname(fileURLToPath(import.meta.url))

// Profile → 版本号后缀单一真源。VALID_PROFILES 由它派生，避免双源漂移
// （未来加新 profile 时只改这张表，不会出现"列入 valid 但忘加 suffix"或反之）。
// production 后缀为空字符串——派生时返回 sourceVersion 原样。
const PROFILE_SUFFIX = {
  production: '',
  preprod: '-preprod.1',
  local: '-local.1',
}
const VALID_PROFILES = new Set(Object.keys(PROFILE_SUFFIX))

export function readSourceVersion() {
  const pkgPath = resolve(__dirname, '..', 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) {
    throw new Error(
      `apps/tabtin-electron/package.json 缺少 "version" 字段或值为空（pkgPath=${pkgPath}）`,
    )
  }
  return pkg.version
}

export function resolveAppVersion(profile, sourceVersion) {
  const version = sourceVersion ?? readSourceVersion()
  const trimmedProfile = (profile ?? '').toString().trim()
  if (!trimmedProfile) {
    return version
  }
  if (!VALID_PROFILES.has(trimmedProfile)) {
    throw new Error(
      `Unknown TABTIN_BUILD_PROFILE="${trimmedProfile}"（合法值：production / preprod / local）`,
    )
  }
  // VALID_PROFILES 已由上方 throw 拦截非法 profile，到这里 trimmedProfile
  // 必在表里，suffix 可能是空字符串（production）或 -<profile>.1（preprod / local）。
  return `${version}${PROFILE_SUFFIX[trimmedProfile]}`
}

// CLI 入口判定：用 pathToFileURL 而非字符串拼接 `file://${argv[1]}`。
// 后者在路径含空格（自动 percent-encode）/ Windows（C:\... 反斜杠）下会比较失败，
// 导致 isCli=false 静默退出、stdout 空、build script 拿到 RESOLVED_APP_VERSION=""，
// step 1.1 grep 校验对空值兜不住（grep "" 永远命中）→ 整个 SSOT 防线失效。
// 写法对齐仓库 sibling scripts/prepare-deploy-package.mjs:100。
const isCli = (() => {
  try {
    if (!process.argv[1]) return false
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
})()

if (isCli) {
  const argvProfile = process.argv[2]
  const envProfile = process.env.TABTIN_BUILD_PROFILE
  const profile = (argvProfile ?? envProfile ?? '').toString().trim()
  try {
    process.stdout.write(resolveAppVersion(profile))
  } catch (err) {
    process.stderr.write(
      `[resolve-app-version] ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(1)
  }
}
