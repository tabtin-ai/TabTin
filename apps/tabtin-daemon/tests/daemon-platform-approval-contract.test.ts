import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const currentDir = path.dirname(fileURLToPath(import.meta.url))

describe('Daemon platform approval delivery contract', () => {
  it('relays approval_requested through relay_events instead of the legacy action event', () => {
    const source = fs.readFileSync(
      path.resolve(currentDir, '../src/application/agent/daemon-agent-host.ts'),
      'utf8',
    )
    const start = source.indexOf('publishHumanInteraction:')
    expect(start).toBeGreaterThan(-1)
    const implementation = source.slice(start, start + 600)

    expect(implementation).toContain('this.gateway.relayEvents(sessionId, [event])')
    expect(implementation).not.toContain('sendAgentEvent')
  })
})
