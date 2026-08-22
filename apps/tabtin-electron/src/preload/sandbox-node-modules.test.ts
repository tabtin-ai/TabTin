import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const preloadEntry = join(dirname(fileURLToPath(import.meta.url)), 'index.ts')

describe('sandboxed preload entry', () => {
  it('does not import Node modules that Electron sandbox cannot load', () => {
    const source = readFileSync(preloadEntry, 'utf8')
    expect(source).not.toMatch(/from ['"]node:(?:os|net|fs|fs\/promises)['"]/)
    expect(source).not.toMatch(/from ['"]\.\/local-network-addresses['"]/)
  })
})
