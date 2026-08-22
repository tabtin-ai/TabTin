#!/usr/bin/env node
/**
 *  回归：托盘/Dock 图标必须同时满足——
 * 1) 主进程产物不用 `__dirname`（ESM `.mjs` 下会 ReferenceError，见 ）
 * 2) electron-builder 把 `static/icon.png` 打进 asar（否则相对路径解析失败）
 *
 * 用法（需先 build）：
 *   node scripts/assert-main-tray-icon-asset.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mainDir = join(root, 'out/main')
const pkgPath = join(root, 'package.json')

let failed = false

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const files = pkg.build?.files
const filesList = Array.isArray(files) ? files : []
if (!filesList.includes('static/icon.png')) {
  console.error('[assert-main-tray-icon] package.json build.files 缺少 static/icon.png')
  failed = true
} else {
  console.log('[assert-main-tray-icon] ok build.files includes static/icon.png')
}

if (!existsSync(join(root, 'static/icon.png'))) {
  console.error('[assert-main-tray-icon] 仓库缺少 static/icon.png')
  failed = true
}

if (!existsSync(mainDir)) {
  console.error(`[assert-main-tray-icon] missing ${mainDir} — run electron-vite build first`)
  process.exit(1)
}

const bundles = readdirSync(mainDir).filter((f) => f.startsWith('main-app') && f.endsWith('.mjs'))
if (bundles.length === 0) {
  console.error('[assert-main-tray-icon] no main-app*.mjs under out/main')
  process.exit(1)
}

for (const name of bundles) {
  const text = readFileSync(join(mainDir, name), 'utf8')
  if (/join\(__dirname\s*,\s*["'].*icon/i.test(text) || /__dirname.*icon-.*\.png/.test(text)) {
    console.error(`[assert-main-tray-icon] ${name} still resolves icon via __dirname (ESM crash)`)
    failed = true
  }
  if (!text.includes('static/icon.png') || !text.includes('import.meta.url')) {
    console.error(`[assert-main-tray-icon] ${name} missing import.meta.url + static/icon.png resolution`)
    failed = true
  } else {
    console.log(`[assert-main-tray-icon] ok ${name} uses import.meta.url → static/icon.png`)
  }
}

process.exit(failed ? 1 : 0)
