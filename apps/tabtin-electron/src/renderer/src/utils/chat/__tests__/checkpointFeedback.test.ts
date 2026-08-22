import { describe, expect, it } from 'vitest'

import { buildCheckpointSemanticFeedback } from '../checkpointFeedback'

function formatTranslation(defaultValue: string | undefined, options?: Record<string, unknown>) {
  return Object.entries(options ?? {}).reduce((text, [key, value]) => {
    return text.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value))
  }, defaultValue ?? '')
}

const t = (_key: string, options?: Record<string, unknown> & { defaultValue?: string }) => (
  formatTranslation(options?.defaultValue, options) || _key
)

describe('buildCheckpointSemanticFeedback', () => {
  it('将 ready checkpoint 翻译为完整能力反馈', () => {
    const feedback = buildCheckpointSemanticFeedback({
      checkpointRecord: {
        checkpoint_id: 'msg-1',
        session_id: 'session-1',
        anchor_type: 'assistant_turn',
        status: 'ready',
        capability_scope: {
          message_preview: true,
          file_diff: true,
          file_restore: true,
          resource_restore: true,
          unrevert: true,
        },
        degraded_reasons: [],
      },
    }, t)

    expect(feedback.badgeLabel).toBe('可完整回退')
    expect(feedback.summary).toContain('恢复文件与资源')
    expect(feedback.capabilities.find(item => item.key === 'resource_restore')?.detail).toBe('可恢复文档、表格等资源')
  })

  it('将无有效 checkpoint 的 preview 翻译为只回退对话的反馈', () => {
    const feedback = buildCheckpointSemanticFeedback({
      degradedReasons: ['missing_effective_checkpoint'],
      status: 'unavailable',
      capabilityScope: {
        message_preview: true,
      },
    }, t)

    expect(feedback.badgeLabel).toBe('仅回退对话')
    expect(feedback.summary).toContain('只能回退对话')
    expect(feedback.reasons[0]?.text).toContain('没有找到可用的版本点')
    expect(feedback.capabilities.find(item => item.key === 'message_preview')?.detail).toBe('可先确认会移除哪些消息')
    expect(feedback.capabilities.find(item => item.key === 'file_restore')?.detail).toBe('当前不能自动恢复工作区文件')
  })

  it('无有效 checkpoint 但仍有资源恢复能力时，不误报为仅回退对话', () => {
    const feedback = buildCheckpointSemanticFeedback({
      degradedReasons: ['missing_effective_checkpoint'],
      status: 'unavailable',
      capabilityScope: {
        message_preview: true,
        resource_restore: true,
        unrevert: true,
      },
    }, t)

    expect(feedback.badgeLabel).toBe('回退对话和资源')
    expect(feedback.summary).toContain('恢复可用资源')
    expect(feedback.reasons[0]?.text).toContain('不能恢复工作区文件')
    expect(feedback.capabilities.find(item => item.key === 'resource_restore')?.detail).toBe('可恢复文档、表格等资源')
  })
})
