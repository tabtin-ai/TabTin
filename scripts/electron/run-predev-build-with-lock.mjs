#!/usr/bin/env node
/**
 * 在单进程内持有 workspace 构建锁并执行 predev-build.mjs，
 * 避免与 tabtin-web 等对同一批 packages 并行 tsc 冲突。
 * 透传 argv（--force / --check / --seed <pkg>）。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquire, release } from './workspace-lock.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')
const scriptPath = path.join(root, 'apps', 'tabtin-electron', 'scripts', 'predev-build.mjs')

let exitCode = 1
acquire()
try {
  const r = spawnSync(process.execPath, [scriptPath, ...process.argv.slice(2)], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  })
  exitCode = r.status ?? (r.signal ? 1 : 0)
} finally {
  release()
}
process.exit(exitCode)
