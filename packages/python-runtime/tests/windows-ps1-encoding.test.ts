import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Windows PowerShell 5.1 读无 BOM 的 UTF-8 含中文 .ps1 会 ParserError
describe('build-python-runtime.ps1 encoding', () => {
  it('UTF-8 with BOM', () => {
    const ps1 = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/electron/package/build-python-runtime.ps1')
    expect([...readFileSync(ps1).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })
})
