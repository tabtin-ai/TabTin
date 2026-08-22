import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

import { ResolvedAskChoiceResultCard } from '../messages/hitl/ResolvedAskChoiceResultCard'

describe('ResolvedAskChoiceResultCard', () => {
  it('渲染只读问题与答案卡', () => {
    render(<ResolvedAskChoiceResultCard result={{
      questions: [{
        questionId: 'topic',
        prompt: '你想搜索什么主题？',
        answers: ['人工智能'],
      }],
    }} />)

    expect(screen.getByTestId('resolved-ask-choice-card')).toBeTruthy()
    expect(screen.getByText('askUser.answered')).toBeTruthy()
    expect(screen.getByText('你想搜索什么主题？')).toBeTruthy()
    expect(screen.getByText('人工智能')).toBeTruthy()
  })
})
