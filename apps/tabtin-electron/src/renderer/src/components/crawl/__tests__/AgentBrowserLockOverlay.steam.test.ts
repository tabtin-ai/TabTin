import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Agent browser lock steam border', () => {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const globalsSource = readFileSync(join(currentDir, '../../../styles/globals.css'), 'utf8')
  const steamBlock = globalsSource.match(/\.agent-lock-steam\s*\{[\s\S]*?\n\}/)?.[0]

  it('uses brand-colored flowing stops instead of rainbow', () => {
    expect(steamBlock).toBeTruthy()
    expect(steamBlock).toContain('hsl(var(--primary) / 0.12)')
    expect(steamBlock).toContain('hsl(var(--primary) / 0.5)')
    expect(steamBlock).toContain('hsl(var(--primary) / 0.18)')
    expect(steamBlock).toContain('hsl(var(--primary) / 0.55)')
    expect(steamBlock).toContain('filter: blur(0.4px)')
    expect(steamBlock).not.toContain('rgba(251, 0, 148')
    expect(steamBlock).not.toMatch(/#fb0094\b/)
    expect(steamBlock).not.toMatch(/#00ff00\b/)
    expect(steamBlock).not.toMatch(/#ffff00\b/)
    expect(steamBlock).not.toMatch(/#ff0000\b/)
  })

  it('keeps the existing ring animation contract', () => {
    expect(steamBlock).toContain('background-size: 400%')
    expect(steamBlock).toContain('animation: agent-lock-steam 20s linear infinite')
  })
})
