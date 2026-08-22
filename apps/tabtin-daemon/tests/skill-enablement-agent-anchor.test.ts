import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const runtimeSource = readFileSync(
  resolve(__dirname, '../src/application/agent/runtime/daemon-runtime-assembly.ts'),
  'utf8',
)
const hostSource = readFileSync(
  resolve(__dirname, '../src/application/agent/daemon-agent-host.ts'),
  'utf8',
)

describe('Daemon Agent Skill enablement wiring', () => {
  it('binds Skill enablement to the runtime Agent instead of the Workspace shell', () => {
    expect(runtimeSource).toContain(
      '? host.skills.enablementCache.forAgent(agentId)',
    )
    expect(runtimeSource).toContain('agentSkillEnablement.refresh({ force: true })')
    expect(runtimeSource).toContain('agentSkillEnablement?.getSync()')
    expect(runtimeSource).toContain(
      '[SkillEnablement] missing agentId; all Skills disabled (closed carry set)',
    )
    expect(runtimeSource).not.toMatch(
      /skillEnablementCache\.(?:refresh|getSync)\([^)]*(?:spaceId|workspaceId)/,
    )
    expect(hostSource).toContain('[SkillEnablement] refresh failed agent=')
  })
})
