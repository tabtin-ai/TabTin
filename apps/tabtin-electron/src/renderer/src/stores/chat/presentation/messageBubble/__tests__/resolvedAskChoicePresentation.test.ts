import { describe, expect, it } from 'vitest'
import { deriveResolvedAskChoicePresentation } from '../resolvedAskChoicePresentation'

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    hitl: {
      kind: 'ask_choice',
      status: 'resolved',
      payload: {
        questions: [{
          id: 'topic',
          prompt: '你想搜索什么主题？',
          options: [
            { id: 'ai', label: '人工智能' },
            { id: 'robot', label: '机器人' },
            { id: '__other__', label: '其他' },
          ],
        }],
      },
      result: {
        outcome: 'answered',
        answers: [{ question_id: 'topic', selected_options: ['ai'] }],
      },
      ...overrides,
    },
  }
}

describe('deriveResolvedAskChoicePresentation', () => {
  it('把已回答单选事实映射成问题和用户可见选项标签', () => {
    expect(deriveResolvedAskChoicePresentation(metadata())).toEqual({
      questions: [{
        questionId: 'topic',
        prompt: '你想搜索什么主题？',
        answers: ['人工智能'],
      }],
    })
  })

  it('__other__ 携带自由文本时只展示自由文本', () => {
    const value = metadata({
      result: {
        answers: [{
          question_id: 'topic',
          selected_options: ['__other__'],
          free_text: '具身智能',
        }],
      },
    })

    expect(deriveResolvedAskChoicePresentation(value)).toEqual({
      questions: [{
        questionId: 'topic',
        prompt: '你想搜索什么主题？',
        answers: ['具身智能'],
      }],
    })
  })

  it('兼容 result.response.answers 的既有终态形状', () => {
    const value = metadata({
      result: {
        outcome: '',
        response: {
          answers: [{ question_id: 'topic', selected_options: ['robot'] }],
        },
      },
    })

    expect(deriveResolvedAskChoicePresentation(value)?.questions[0]?.answers).toEqual(['机器人'])
  })

  it('outcome 缺失也接受，但不暴露未知选项 ID', () => {
    expect(deriveResolvedAskChoicePresentation(metadata({
      result: {
        answers: [{ question_id: 'topic', selected_options: ['ai'] }],
      },
    }))?.questions[0]?.answers).toEqual(['人工智能'])

    const value = metadata({
      result: {
        answers: [{ question_id: 'topic', selected_options: ['internal-option-id'] }],
      },
    })

    expect(deriveResolvedAskChoicePresentation(value)).toBeNull()
  })

  it('malformed metadata 安全返回空', () => {
    expect(deriveResolvedAskChoicePresentation({ hitl: { kind: 'ask_choice', status: 'resolved' } })).toBeNull()
    expect(deriveResolvedAskChoicePresentation({ hitl: [] })).toBeNull()
    expect(deriveResolvedAskChoicePresentation(null)).toBeNull()
  })

  it.each([
    ['pending', metadata({ status: 'pending' })],
    ['skipped', metadata({ result: { outcome: 'skipped', answers: [] } })],
    ['cancelled', metadata({ status: 'cancelled' })],
    ['expired', metadata({ status: 'expired' })],
    ['other kind', metadata({ kind: 'ask_form' })],
  ])('%s 不生成可见结果', (_label, value) => {
    expect(deriveResolvedAskChoicePresentation(value)).toBeNull()
  })
})
