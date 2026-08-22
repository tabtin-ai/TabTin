import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

describe('ExecutionReadinessSummary', () => {
  it('uses the renderer Skills query instead of legacy /skills/index', () => {
    const sourcePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../ExecutionReadinessSummary.tsx',
    )
    const source = readFileSync(sourcePath, 'utf8')

    expect(source).toContain("import { useSkillsListQuery } from '@/hooks/queries/skills'")
    expect(source).toContain('useSkillsListQuery(space.id)')
    expect(source).not.toContain('fetchSpaceSkills')
    expect(source).not.toContain('API_ENDPOINTS.SKILLS.INDEX')
    expect(source).not.toContain('/skills/index')
  })

  it('only renders MCP readiness card when snapshot includes mcp_server', () => {
    const sourcePath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../ExecutionReadinessSummary.tsx',
    )
    const source = readFileSync(sourcePath, 'utf8')

    expect(source).toContain('effectiveMcpStatus ? (')
    expect(source).not.toContain('mcp:getStatus')
    expect(source).not.toContain('window.tabtin.mcp')
  })
})
