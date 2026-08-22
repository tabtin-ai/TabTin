import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import {
  CollapsibleMessage,
  MSG_COLLAPSE_CHAR_THRESHOLD,
  MSG_COLLAPSED_PREVIEW_LEN,
} from '../messages/common/CollapsibleMessage'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; lines?: number; count?: number }) => {
      if (opts?.defaultValue) {
        return opts.defaultValue
          .replace('{{lines}}', String(opts.lines ?? ''))
          .replace('{{count}}', String(opts.count ?? ''))
      }
      return key
    },
  }),
}))

function renderCollapsed(content: string, messageId = 'msg-1') {
  return render(
    <CollapsibleMessage
      messageId={messageId}
      content={content}
      shouldCollapse={content.length > MSG_COLLAPSE_CHAR_THRESHOLD}
    >
      {() => <div data-testid="full-body">{content}</div>}
    </CollapsibleMessage>,
  )
}

describe('CollapsibleMessage', () => {
  it('短消息不折叠，直接渲染全文', () => {
    renderCollapsed('hello world')
    expect(screen.getByTestId('full-body').textContent).toBe('hello world')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('长消息默认折叠，只显示预览与展开按钮', () => {
    const long = 'A'.repeat(MSG_COLLAPSE_CHAR_THRESHOLD + 50)
    renderCollapsed(long, 'msg-long-1')
    expect(screen.queryByTestId('full-body')).toBeNull()
    expect(screen.getByRole('button').textContent).toMatch(/展开全文|Expand full/)
    expect(document.body.textContent).toContain('A'.repeat(MSG_COLLAPSED_PREVIEW_LEN))
    expect(document.body.textContent).not.toContain(long)
  })

  it('点击展开后显示全文，并可再收起', () => {
    const long = 'B'.repeat(MSG_COLLAPSE_CHAR_THRESHOLD + 80)
    renderCollapsed(long, 'msg-long-2')
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('full-body').textContent).toBe(long)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByTestId('full-body')).toBeNull()
  })

  it('展开前通知上层停止自动贴底，并通过过渡容器渲染全文', () => {
    const onExpand = vi.fn()
    const long = 'R'.repeat(MSG_COLLAPSE_CHAR_THRESHOLD + 80)
    render(
      <CollapsibleMessage
        messageId="msg-reading-anchor"
        content={long}
        shouldCollapse
        onExpand={onExpand}
      >
        {() => <div data-testid="full-body">{long}</div>}
      </CollapsibleMessage>,
    )

    fireEvent.click(screen.getByRole('button', { name: /展开全文|Expand full/ }))

    expect(onExpand).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('collapsible-message-transition')).toBeTruthy()
    expect(screen.getByTestId('full-body').textContent).toBe(long)
  })

  // : height:0→auto 首帧会先缩后涨，导致阅读锚点漂移
  it('点击展开后过渡 DOM 不得以 height:0 起局，全文须同步存在且 onExpand 仍先调用', () => {
    const onExpand = vi.fn()
    const long = 'H'.repeat(MSG_COLLAPSE_CHAR_THRESHOLD + 80)
    render(
      <CollapsibleMessage
        messageId="msg-height-contract"
        content={long}
        shouldCollapse
        onExpand={onExpand}
      >
        {() => <div data-testid="full-body">{long}</div>}
      </CollapsibleMessage>,
    )

    fireEvent.click(screen.getByRole('button', { name: /展开全文|Expand full/ }))

    expect(onExpand).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('full-body').textContent).toBe(long)

    const transition = screen.getByTestId('collapsible-message-transition')
    const inlineStyle = transition.getAttribute('style') ?? ''
    expect(inlineStyle).not.toMatch(/height:\s*0(px)?/i)
    expect(transition.style.height).not.toMatch(/^0(px)?$/)
  })

  it('shouldCollapse 从 false 变为 true 时保持展开（流式刚结束不突然收起）', () => {
    const long = 'C'.repeat(MSG_COLLAPSE_CHAR_THRESHOLD + 20)
    const { rerender } = render(
      <CollapsibleMessage messageId="msg-stream" content={long} shouldCollapse={false}>
        {() => <div data-testid="full-body">{long}</div>}
      </CollapsibleMessage>,
    )
    expect(screen.getByTestId('full-body')).toBeTruthy()

    rerender(
      <CollapsibleMessage messageId="msg-stream" content={long} shouldCollapse>
        {() => <div data-testid="full-body">{long}</div>}
      </CollapsibleMessage>,
    )
    expect(screen.getByTestId('full-body')).toBeTruthy()
    expect(screen.getByRole('button').textContent).toMatch(/收起|Show less/)
  })
})
