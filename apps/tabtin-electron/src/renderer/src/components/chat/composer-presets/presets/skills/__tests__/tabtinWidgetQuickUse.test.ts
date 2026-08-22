import { describe, expect, it } from 'vitest'
import {
  buildTabtinWidgetQuickUsePrompt,
  TABTIN_WIDGET_QUICK_USE_PRESET,
  TABTIN_WIDGET_QUICK_USE_PRESET_ID,
  TABTIN_WIDGET_SKILL_KEY,
} from '../tabtinWidgetQuickUse'

describe('tabtinWidgetQuickUse preset', () => {
  it('builds a readable prompt from filled fields', () => {
    expect(buildTabtinWidgetQuickUsePrompt({
      subject: '产品增长飞轮',
      style: '科技感',
      focus: '突出获客、激活、留存三段关系',
    })).toBe([
      '请使用 tabtin-widget，帮我生成一个 产品增长飞轮。',
      '视觉风格：科技感',
      '重点展示：突出获客、激活、留存三段关系',
      '输出要求：优先用 Mermaid 或 SVG，适合在 chat 中直接查看。',
    ].join('\n'))
  })

  it('serializes skill key and rendered prompt for composer preset send', () => {
    const block = TABTIN_WIDGET_QUICK_USE_PRESET.serializeForSend?.(
      {
        subject: '新用户 onboarding 流程',
        style: '清晰简洁',
        focus: '',
      },
      {},
      { source: 'skill_detail_quick_use' },
    )

    expect(block).toEqual({
      type: 'composer_preset',
      preset_id: TABTIN_WIDGET_QUICK_USE_PRESET_ID,
      params: {
        skill_key: TABTIN_WIDGET_SKILL_KEY,
        subject: '新用户 onboarding 流程',
        style: '清晰简洁',
        focus: '',
        rendered_prompt: [
          '请使用 tabtin-widget，帮我生成一个 新用户 onboarding 流程。',
          '视觉风格：清晰简洁',
          '重点展示：展示每天的天气、最高/最低温、降雨概率和出行提醒',
          '输出要求：优先用 Mermaid 或 SVG，适合在 chat 中直接查看。',
        ].join('\n'),
      },
      trigger_context: { source: 'skill_detail_quick_use' },
    })
  })

  it('requires subject before submit', () => {
    expect(TABTIN_WIDGET_QUICK_USE_PRESET.renderer).toBe('skillQuickUsePreview')
    expect(TABTIN_WIDGET_QUICK_USE_PRESET.canSubmit?.({ subject: '产品增长飞轮' })).toBe(true)
    expect(TABTIN_WIDGET_QUICK_USE_PRESET.canSubmit?.({ subject: '   ' })).toBe(false)
    expect(TABTIN_WIDGET_QUICK_USE_PRESET.canSubmit?.({})).toBe(false)
  })
})
