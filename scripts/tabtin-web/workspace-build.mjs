#!/usr/bin/env node
/**
 * tabtin-web 的 table 相关 workspace 串行构建（与 predev-build 共用锁）。
 */
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquire, release } from '../electron/workspace-lock.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..', '..')

// Wave 5 §F：platform-adapter / agent-wire 是 tabtin-web 的 type-only 依赖，
// 之前 baseline typecheck 报"找不到模块"就是它们的 dist 没生成。把它们放在
// 链最前面 —— 后续 table-core / smartsheet-ui 不引用它们，加入顺序无相互依赖。
const chain = [
  'pnpm --filter @tabtin/platform-adapter build',
  'pnpm --filter @tabtin/agent-wire build',
  'pnpm --filter @tabtin/table-core build',
  'pnpm --filter @tabtin/table-engine build',
  'pnpm --filter @tabtin/smartsheet-ui build',
  'pnpm --filter @tabtin/table-ui build',
  'pnpm --filter @tabtin/table-engine-canvas build',
].join(' && ')

acquire()
try {
  execSync(chain, { cwd: root, stdio: 'inherit', env: process.env })
} finally {
  release()
}
