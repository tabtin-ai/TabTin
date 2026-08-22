import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('AssignSkillToAgentDialog 默认 Agent 锁定契约', () => {
  it('已配置的默认 Agent 置灰且不可取消，全不选保留必选项', () => {
    const source = readFileSync(
      resolve(__dirname, '../AssignSkillToAgentDialog.tsx'),
      'utf8',
    )

    expect(source).toContain('resolveLockedAssignedAgentIds')
    expect(source).toContain('disabled={locked}')
    expect(source).toContain("'cursor-not-allowed border-border/60 bg-muted/30 opacity-55'")
    expect(source).toContain("t('skills.marketplace.agentDialog.lockedLabel'")
    expect(source).toContain('allMutableSelected')
    expect(source).toContain('new Set(lockedAgentIds)')
  })
})
