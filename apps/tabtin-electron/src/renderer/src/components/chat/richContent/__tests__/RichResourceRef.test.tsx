import React from 'react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { RichContentBlock } from '@tabtin/chat-client'
import { RichResourceRef, _clearRichResourceAutoOpenKeys } from '../RichResourceRef'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

const block: RichContentBlock = {
  kind: 'resource_ref',
  resource_type: 'tabdoc',
  resource_id: 'doc-1',
  title: 'README.md',
  open_label: '打开文档',
}

describe('RichResourceRef', () => {
  beforeEach(() => {
    _clearRichResourceAutoOpenKeys()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('整卡可点击，点击标题区域也会触发 onNavigate', () => {
    const onNavigate = vi.fn()
    render(<RichResourceRef block={block} onNavigate={onNavigate} />)

    const card = screen.getByTestId('rich-resource-ref')
    expect(card.tagName).toBe('BUTTON')

    fireEvent.click(screen.getByText('README.md'))
    expect(onNavigate).toHaveBeenCalledWith('tabdoc', 'doc-1', undefined, undefined)
  })

  it('点击时把资源真实归属工作空间透传到导航链路', () => {
    const onNavigate = vi.fn()
    render(
      <RichResourceRef
        block={{ ...block, space_id: 'workspace-source-1' } as RichContentBlock}
        onNavigate={onNavigate}
      />,
    )

    fireEvent.click(screen.getByTestId('rich-resource-ref'))

    expect(onNavigate).toHaveBeenCalledWith(
      'tabdoc',
      'doc-1',
      undefined,
      { resourceSpaceId: 'workspace-source-1' },
    )
  })

  it('新鲜 auto_open token 会同步调用 onNavigate 打开 Space 工作区', () => {
    vi.useFakeTimers()
    const onNavigate = vi.fn()
    const token = `present-${Date.now().toString(36)}-test1`
    const autoBlock: RichContentBlock = {
      ...block,
      resource_id: 'doc-auto',
      auto_open: true,
      auto_open_token: token,
    }

    render(<RichResourceRef block={autoBlock} onNavigate={onNavigate} />)
    vi.runAllTimers()

    expect(onNavigate).toHaveBeenCalledTimes(1)
    expect(onNavigate).toHaveBeenCalledWith('tabdoc', 'doc-auto', undefined, undefined)

    // 同 token 再挂载不应重复打开
    render(<RichResourceRef block={autoBlock} onNavigate={onNavigate} />)
    vi.runAllTimers()
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })

  it('过期 present token 不自动打开（历史回放）', () => {
    vi.useFakeTimers()
    const onNavigate = vi.fn()
    const staleMs = Date.now() - 10 * 60_000
    render(
      <RichResourceRef
        block={{
          ...block,
          auto_open: true,
          auto_open_token: `present-${staleMs.toString(36)}-stale`,
        }}
        onNavigate={onNavigate}
      />,
    )
    vi.runAllTimers()
    expect(onNavigate).not.toHaveBeenCalled()
  })
})
