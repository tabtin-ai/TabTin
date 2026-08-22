import { describe, expect, it } from 'vitest'
import { generateRandomWorkspaceName } from '../generateRandomWorkspaceName'

describe('generateRandomWorkspaceName', () => {
  it('uses workspace- prefix with 6 alphanumeric chars ', () => {
    const name = generateRandomWorkspaceName()
    expect(name).toMatch(/^workspace-[a-z0-9]{6}$/)
    expect(name.startsWith('Space-')).toBe(false)
  })

  it('produces distinct names across calls', () => {
    const names = new Set(
      Array.from({ length: 20 }, () => generateRandomWorkspaceName()),
    )
    expect(names.size).toBeGreaterThan(1)
  })
})
