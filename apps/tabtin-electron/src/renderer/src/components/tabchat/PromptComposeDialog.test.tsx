import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PromptComposeDialog } from './PromptComposeDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; name?: string }) => {
      if (typeof options?.defaultValue === 'string') {
        return options.defaultValue.replace('{{name}}', options.name ?? '')
      }
      return _key
    },
  }),
}))

describe('PromptComposeDialog', () => {
  it('CTA 使用发给 {名字}', () => {
    const onSend = vi.fn()
    render(
      <PromptComposeDialog
        isOpen
        onClose={() => {}}
        onSend={onSend}
        recipientName="小叶"
      />,
    )

    expect(screen.getByRole('button', { name: '发给 小叶' })).toBeTruthy()
    expect(screen.queryByText('发给', { selector: 'div' })).toBeNull()
  })

  it('发送时用首行作为 title', () => {
    const onSend = vi.fn()
    render(
      <PromptComposeDialog
        isOpen
        onClose={() => {}}
        onSend={onSend}
        recipientName="小叶"
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '客户回访话术\n第二段细节' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发给 小叶' }))

    expect(onSend).toHaveBeenCalledWith('客户回访话术\n第二段细节', '客户回访话术')
  })
})
