import { describe, expect, it } from 'vitest'
import {
  getAgentRequestContextHeaders,
  runWithAgentRequestContext,
} from '../agent-request-context'

describe('agent request context', () => {
  it('keeps headers isolated across concurrent requests', async () => {
    const readAfterYield = async () => {
      await Promise.resolve()
      return getAgentRequestContextHeaders()['X-Tabtin-Agent-Run-Id']
    }

    const values = await Promise.all([
      runWithAgentRequestContext(
        { 'X-Tabtin-Agent-Run-Id': 'run-a' },
        readAfterYield,
      ),
      runWithAgentRequestContext(
        { 'X-Tabtin-Agent-Run-Id': 'run-b' },
        readAfterYield,
      ),
    ])

    expect(values).toEqual(['run-a', 'run-b'])
    expect(getAgentRequestContextHeaders()).toEqual({})
  })

  it('returns an empty context outside a scoped request', () => {
    expect(getAgentRequestContextHeaders()).toEqual({})
  })
})
