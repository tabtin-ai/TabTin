#!/usr/bin/env node
/**
 * 只读 CLI 入口 —— 逻辑在 ensure-build-tag.mjs。
 * @see ensure-build-tag.mjs
 */
export { resolveBuildTag } from './ensure-build-tag.mjs'

import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveBuildTag } from './ensure-build-tag.mjs'

const isCli = (() => {
  try {
    if (!process.argv[1]) return false
    return pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  } catch {
    return false
  }
})()

if (isCli) {
  const tag = resolveBuildTag()
  if (tag) {
    process.stdout.write(`${tag}\n`)
    process.exit(0)
  }
  process.stderr.write('[resolve-build-tag] 未找到 *-alpha.* tag\n')
  process.exit(1)
}
