import { describe, expect, it } from 'vitest'
import type { SkillIndexEntry } from '@/skills/types'
import { buildSlashCommandOptions } from '../../../skill/skillSlashCommand'
import { prepareComposerSendContent } from '../prepareComposerSendContent'

function skill(overrides: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    skill_id: overrides.skill_id ?? overrides.slug ?? 'skill-1',
    skill_key: overrides.skill_key ?? `user:${overrides.slug ?? 'skill-1'}`,
    slug: overrides.slug,
    name: overrides.name ?? overrides.slug ?? 'Skill One',
    source: overrides.source ?? 'user',
    installed: overrides.installed ?? true,
    agent_enabled: overrides.agent_enabled ?? true,
    enabled: overrides.enabled,
    ...overrides,
  }
}

describe('prepareComposerSendContent', () => {
  const slashOptions = buildSlashCommandOptions([
    skill({ slug: 'meeting-notes', skill_key: 'app:office/meeting-notes' }),
  ])

  it('结构化匹配已启用 Skill', () => {
    const prepared = prepareComposerSendContent({
      input: '/meeting-notes summarize today',
      attachmentsCount: 0,
      contextRefsCount: 0,
      hasActivePresets: false,
      conversationReferenceRefs: [],
      slashOptions,
    })
    expect(prepared.skillSendOptions?.skillSlashInvoke).toEqual({
      skillKey: 'app:office/meeting-notes',
      args: 'summarize today',
    })
    expect(prepared.unrecognizedSlashToken).toBeNull()
  })

  it('未识别 leading slash 时返回 token', () => {
    const prepared = prepareComposerSendContent({
      input: '/lark-approval 帮我审批',
      attachmentsCount: 0,
      contextRefsCount: 0,
      hasActivePresets: false,
      conversationReferenceRefs: [],
      slashOptions,
    })
    expect(prepared.skillSendOptions).toBeUndefined()
    expect(prepared.unrecognizedSlashToken).toBe('/lark-approval')
    expect(prepared.message).toBe('/lark-approval 帮我审批')
  })

  it('/compact 不受未识别拦截影响', () => {
    const prepared = prepareComposerSendContent({
      input: '/compact 保留接口',
      attachmentsCount: 0,
      contextRefsCount: 0,
      hasActivePresets: false,
      conversationReferenceRefs: [],
      slashOptions,
    })
    expect(prepared.compactArgs).toBe('保留接口')
    expect(prepared.unrecognizedSlashToken).toBeNull()
  })
})
