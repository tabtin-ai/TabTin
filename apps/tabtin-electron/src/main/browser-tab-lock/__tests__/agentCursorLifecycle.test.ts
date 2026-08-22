import { describe, expect, it, vi } from 'vitest'
import { hideAgentCursorOnViews } from '../agentCursorLifecycle'

describe('hideAgentCursorOnViews', () => {
  it('injects hide script for each released view', async () => {
    const runScript = vi.fn(async () => undefined)
    hideAgentCursorOnViews(['view-a', 'view-b'], runScript)
    await Promise.resolve()
    expect(runScript).toHaveBeenCalledTimes(2)
    expect(runScript.mock.calls[0]?.[1]).toBe('view-a')
    expect(runScript.mock.calls[1]?.[1]).toBe('view-b')
    expect(String(runScript.mock.calls[0]?.[0])).toContain('__tabtinAgentCursorHide()')
    expect(String(runScript.mock.calls[0]?.[0])).not.toMatch(/__tabtinAgentCursorEnsure\(\);\s*__tabtinAgentCursorHide/)
  })

  it('swallows runScript rejection', async () => {
    const runScript = vi.fn(async () => {
      throw new Error('gone')
    })
    expect(() => hideAgentCursorOnViews(['view-a'], runScript)).not.toThrow()
    await Promise.resolve()
    expect(runScript).toHaveBeenCalledTimes(1)
  })
})
