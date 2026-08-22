/**
 * 从 material-icon-theme 提取文件图标 SVG 并生成 manifest。
 *
 * 用法: node scripts/generate-file-icons.mjs
 *
 * 输出: static/file-icons/ 目录（SVG + manifest.json）
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const require = createRequire(import.meta.url)

const ROOT = resolve(__dirname, '..')
const OUT_DIR = resolve(ROOT, 'static/file-icons')
const ICONS_SRC = resolve(ROOT, 'node_modules/material-icon-theme/icons')

const { generateManifest } = require('material-icon-theme')

const manifest = generateManifest({
  activeIconPack: 'react',
  folders: { theme: 'specific' },
})

const referencedIcons = new Set()
const addIcon = (name) => { if (name) referencedIcons.add(name) }

addIcon(manifest.file)
addIcon(manifest.folder)
addIcon(manifest.folderExpanded)

for (const icon of Object.values(manifest.fileNames ?? {})) addIcon(icon)
for (const icon of Object.values(manifest.fileExtensions ?? {})) addIcon(icon)
for (const icon of Object.values(manifest.folderNames ?? {})) addIcon(icon)
for (const icon of Object.values(manifest.folderNamesExpanded ?? {})) addIcon(icon)

const condensed = {
  fileNames: manifest.fileNames ?? {},
  fileExtensions: manifest.fileExtensions ?? {},
  folderNames: manifest.folderNames ?? {},
  folderNamesExpanded: manifest.folderNamesExpanded ?? {},
  defaultIcon: manifest.file ?? 'file',
  defaultFolderIcon: manifest.folder ?? 'folder',
  defaultFolderOpenIcon: manifest.folderExpanded ?? 'folder-open',
}

if (existsSync(OUT_DIR)) {
  rmSync(OUT_DIR, { recursive: true })
}
mkdirSync(OUT_DIR, { recursive: true })

let copied = 0
for (const iconName of referencedIcons) {
  const srcPath = resolve(ICONS_SRC, `${iconName}.svg`)
  const destPath = resolve(OUT_DIR, `${iconName}.svg`)
  if (existsSync(srcPath)) {
    cpSync(srcPath, destPath)
    copied++
  }
}

writeFileSync(resolve(OUT_DIR, 'manifest.json'), JSON.stringify(condensed, null, 2))

console.log(
  `Generated file icons: ${copied} SVGs copied, ` +
  `${Object.keys(condensed.fileNames).length} file names, ` +
  `${Object.keys(condensed.fileExtensions).length} extensions, ` +
  `${Object.keys(condensed.folderNames).length} folder names`
)
