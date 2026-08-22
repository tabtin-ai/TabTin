import { describe, expect, it } from 'vitest'
import {
  buildSkillQuickUseGeneratedState,
  resolveSkillQuickUse,
} from '@/components/chat/composer-presets/presets/skills/skillQuickUse'
import { getComposerPreset } from '@/components/chat/composer-presets/registry/composerPresetRegistry'
import type { SkillIndexEntry } from '@/skills/types'

const tabtinWidgetEntry = {
  skill_id: 'sk-tabtin-widget',
  name: 'tabtin-widget',
  source: 'platform',
  skill_key: 'platform:visualization/tabtin-widget',
} as SkillIndexEntry

describe('Skill quick use auto draft', () => {
  it('builtin（tabtin-widget）：resolveSkillQuickUse 命中代码注册表，返回单项列表', () => {
    const resolved = resolveSkillQuickUse(tabtinWidgetEntry)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].presetId).toBe('skill.tabtinWidget.quickUse')
    expect(resolved[0].requiredKeys).toContain('subject')
  })

  it('user 来源：读 quick_use 列表并动态注册 preset', () => {
    const userSkill = {
      skill_id: 'sk-user-1',
      name: 'My Skill',
      source: 'user',
      skill_key: 'user:my-skill',
      quick_use: [{
        id: 'doc',
        label: '写文档',
        promptTemplate: '帮我写一份关于 {{topic}} 的文档',
        variables: [{ key: 'topic', type: 'input', label: '主题' }],
        canSubmitKeys: ['topic'],
      }],
    } as SkillIndexEntry

    const resolved = resolveSkillQuickUse(userSkill)
    expect(resolved).toHaveLength(1)
    expect(resolved[0].presetId).toBe('skill.quickUse.user:user:my-skill#doc')
    expect(resolved[0].skillKey).toBe('user:my-skill')
    expect(resolved[0].requiredKeys).toEqual(['topic'])
  })

  it('builtin（tabtin-widget）：自动生成可发送 state，不再要求用户先填表', () => {
    const quickUse = resolveSkillQuickUse(tabtinWidgetEntry)[0]
    const state = buildSkillQuickUseGeneratedState(quickUse)
    const descriptor = getComposerPreset(quickUse.presetId)

    expect(state).toMatchObject({
      subject: '上海未来一周天气趋势图',
      style: '清晰简洁',
      focus: '展示每天的天气、最高/最低温、降雨概率和出行提醒',
    })
    expect(descriptor?.renderer).toBe('skillQuickUsePreview')
    expect(descriptor?.canSubmit?.(state)).toBe(true)
  })

  it('user 来源：必填槽位没有默认值时，也会生成天气示例 state', () => {
    const userSkill = {
      skill_id: 'sk-user-2',
      name: 'My Skill',
      source: 'user',
      skill_key: 'user:auto-topic',
      quick_use: [{
        id: 'doc',
        label: '写文档',
        promptTemplate: '帮我写一份关于 {{topic}} 的文档',
        variables: [{ key: 'topic', type: 'input', label: '主题' }],
        canSubmitKeys: ['topic'],
      }],
    } as SkillIndexEntry

    const quickUse = resolveSkillQuickUse(userSkill)[0]
    const state = buildSkillQuickUseGeneratedState(quickUse)
    const descriptor = getComposerPreset(quickUse.presetId)

    expect(state.topic).toBe('上海近一周天气变化')
    expect(descriptor?.renderer).toBe('skillQuickUsePreview')
    expect(descriptor?.variables?.[0].defaultValue).toBe('上海近一周天气变化')
    expect(descriptor?.canSubmit?.(state)).toBe(true)
  })
})
