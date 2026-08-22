import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const preloadIndex = resolve(here, '../index.ts')

describe('sandbox preload imports ', () => {
  it('does not pull node:os, node:net, or local-network-addresses into preload', () => {
    const source = readFileSync(preloadIndex, 'utf8')
    expect(source).not.toMatch(/from ['"]node:os['"]/)
    expect(source).not.toMatch(/from ['"]node:net['"]/)
    expect(source).not.toMatch(/local-network-addresses/)
  })
})
