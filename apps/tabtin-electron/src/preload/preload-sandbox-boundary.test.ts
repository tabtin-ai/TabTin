import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PRELOAD_DIR = dirname(fileURLToPath(import.meta.url))

function productionTypeScriptFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return productionTypeScriptFiles(path)
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return []
    return [path]
  })
}

describe('sandbox preload boundary', () => {
  it('does not load Node built-in modules at runtime', () => {
    const offenders = productionTypeScriptFiles(PRELOAD_DIR).flatMap((path) =>
      readFileSync(path, 'utf8')
        .split(/\r?\n/)
        .map((line, index) => ({ path, line: index + 1, source: line.trim() }))
        .filter(({ source }) => {
          if (source.startsWith('import type ')) return false
          return (
            /\bfrom\s+['"]node:/.test(source) ||
            /\b(?:import|require)\(\s*['"]node:/.test(source)
          )
        }),
    )

    expect(offenders).toEqual([])
  })
})
