#!/usr/bin/env node
/**
 * 门禁：禁止 packages/agent-host/src 新增模块级权威 Map（ Phase 5）。
 *
 * 扫描 state/ 与 policy/host-turn-state-store.ts 顶层 `= new Map(`。
 * 用法：node packages/agent-host/scripts/check-no-module-maps.mjs
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(packageRoot, 'src')

const SCAN_DIRS = [
  path.join(srcRoot, 'state'),
]
const SCAN_FILES = [
  path.join(srcRoot, 'policy', 'host-turn-state-store.ts'),
]

function listTsFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'tests') continue
      out.push(...listTsFiles(full))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

function isModuleLevelMap(line) {
  const trimmed = line.trim()
  if (!trimmed.includes('= new Map(')) return false
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false
  if (/^\s*(private|public|protected|readonly)\s/.test(line)) return false
  if (/^\s*#\w/.test(line)) return false
  return true
}

const violations = []

for (const file of [
  ...SCAN_DIRS.flatMap(listTsFiles),
  ...SCAN_FILES.filter(f => fs.existsSync(f)),
]) {
  const rel = path.relative(packageRoot, file)
  const lines = fs.readFileSync(file, 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (isModuleLevelMap(lines[i])) {
      violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`)
    }
  }
}

if (violations.length > 0) {
  console.error('[check-no-module-maps] 发现模块级权威 Map：')
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}

console.log('[check-no-module-maps] OK — 未发现模块级 `= new Map(`')
