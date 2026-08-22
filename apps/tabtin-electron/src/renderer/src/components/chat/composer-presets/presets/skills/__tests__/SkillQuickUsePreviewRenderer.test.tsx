import React, { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SkillQuickUsePreviewRenderer } from '../SkillQuickUsePreviewRenderer'
import type { ComposerPresetDescriptor } from '../../../registry/types'

const preset: ComposerPresetDescriptor = {
  id: 'skill.test.quickUse',
  labelKey: '快速使用 test-skill',
  category: 'skill',
  promptTemplate: [
    '请生成 {{subject}}。',
    '视觉风格：{{style}}',
    '重点展示：{{focus}}',
  ].join('\n'),
  variables: [
    { key: 'subject', type: 'textarea', label: '要画什么', defaultValue: '默认主题' },
    {
      key: 'style',
      type: 'select',
      label: '视觉风格',
      defaultValue: '清晰简洁',
      options: [
        { value: '清晰简洁', label: '清晰简洁' },
        { value: '科技感', label: '科技感' },
      ],
    },
    { key: 'focus', type: 'textarea', label: '重点信息', defaultValue: '默认重点' },
  ],
}

function Harness() {
  const [state, setState] = useState<Record<string, unknown>>({
    subject: '默认主题',
    style: '清晰简洁',
    focus: '默认重点',
  })
  return (
    <SkillQuickUsePreviewRenderer
      preset={preset}
      state={state}
      onChange={patch => setState(prev => ({ ...prev, ...patch }))}
      addSlotAttachment={vi.fn()}
      removeSlotAttachment={vi.fn()}
      slotAttachments={{}}
    />
  )
}

describe('SkillQuickUsePreviewRenderer', () => {
  it('允许用户微调预填字段，并实时更新最终提示词预览', () => {
    render(<Harness />)

    expect(screen.getByText(/请生成 默认主题/)).toBeTruthy()

    fireEvent.change(screen.getByDisplayValue('默认主题'), {
      target: { value: '产品增长飞轮' },
    })
    fireEvent.click(screen.getByRole('button', { name: '科技感' }))
    fireEvent.change(screen.getByDisplayValue('默认重点'), {
      target: { value: '突出获客、激活、留存三段关系' },
    })

    expect(screen.getByText(/请生成 产品增长飞轮/)).toBeTruthy()
    expect(screen.getByText(/视觉风格：科技感/)).toBeTruthy()
    expect(screen.getByText(/重点展示：突出获客、激活、留存三段关系/)).toBeTruthy()
  })
})
