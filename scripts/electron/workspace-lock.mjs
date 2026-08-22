#!/usr/bin/env node
/**
 * 跨进程互斥：避免 tabtin-electron predev-build 与 tabtin-web build:workspace:table
 * 等对同一 workspace 包并行 tsc/vite 写入 dist 导致的竞态与大量虚假 TS 错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LOCK_PATH = path.join(
  __dirname,
  '..',
  '..',
  'packages',
  '.tabtin-workspace-build.lock',
)

const MAX_WAIT_MS = 45 * 60 * 1000
const POLL_MS = 120

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4)
  const ia = new Int32Array(sab)
  Atomics.wait(ia, 0, 0, ms)
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** @returns {boolean} 是否由本进程持有 */
export function acquire() {
  const started = Date.now()
  while (Date.now() - started < MAX_WAIT_MS) {
    if (fs.existsSync(LOCK_PATH)) {
      const data = readLock()
      const holder = data?.pid
      if (holder === process.pid) return true
      if (holder != null && !isPidAlive(holder)) {
        try {
          fs.unlinkSync(LOCK_PATH)
        } catch {
          /* ignore */
        }
        continue
      }
      sleepMs(POLL_MS)
      continue
    }
    try {
      fs.writeFileSync(
        LOCK_PATH,
        JSON.stringify({ pid: process.pid, ts: Date.now() }, null, 0),
        { flag: 'wx' },
      )
      return true
    } catch {
      sleepMs(POLL_MS)
    }
  }
  throw new Error(
    `[tabtin-workspace-lock] 等待构建锁超时（${MAX_WAIT_MS / 60000} 分钟）：${LOCK_PATH}`,
  )
}

export function release() {
  if (!fs.existsSync(LOCK_PATH)) return
  const data = readLock()
  if (data?.pid === process.pid) {
    try {
      fs.unlinkSync(LOCK_PATH)
    } catch {
      /* ignore */
    }
  }
}
