import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_UPWARD_LEVELS = 5
let cached: string | null = null

export function readDaemonVersion(): string {
  if (cached !== null) return cached
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let level = 0; level < MAX_UPWARD_LEVELS; level++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
          name?: string
          version?: string
        }
        if (pkg.name === '@tabtin/daemon') {
          cached = pkg.version ?? 'unknown'
          return cached
        }
      } catch { /* keep walking */ }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* use fallback */ }
  cached = 'unknown'
  return cached
}
