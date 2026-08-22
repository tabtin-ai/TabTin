import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../scripts/check-no-module-maps.mjs',
)

describe('check-no-module-maps ', () => {
  it('state/ 与 host-turn-state-store 无模块级权威 Map', () => {
    expect(() => {
      execFileSync(process.execPath, [scriptPath], { stdio: 'pipe' })
    }).not.toThrow()
  })
})
