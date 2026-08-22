import React, { useRef } from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ChatNoticeStack } from '../ChatNoticeStack'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: Record<string, unknown>) => {
      if (_key === 'noticeStack.page') {
        return `${opts?.current}/${opts?.total}`
      }
      return String(opts?.defaultValue ?? _key)
    },
  }),
}))

function notice(id: string) {
  return (
    <div key={id} data-testid={id} data-chat-notice>
      {id}
    </div>
  )
}

const isHidden = (el: HTMLElement | null | undefined) => el?.style.display === 'none'

function pagerIn(noticeTestId: string) {
  const card = screen.getByTestId(noticeTestId)
  return card.querySelector('[data-testid="chat-notice-stack-pager"]')
}

describe('ChatNoticeStack', () => {
  it('不出分页控件：0 条通知', () => {
    render(<ChatNoticeStack>{null}</ChatNoticeStack>)
    expect(document.querySelector('[data-testid="chat-notice-stack-pager"]')).toBeNull()
  })

  it('不出分页控件、原样展示：1 条通知', () => {
    render(<ChatNoticeStack>{notice('n1')}</ChatNoticeStack>)
    expect(pagerIn('n1')).toBeNull()
    expect(isHidden(screen.getByTestId('n1'))).toBe(false)
  })

  it('≥2 条默认只显示最新一条，页码在卡片内 y/y', async () => {
    render(
      <ChatNoticeStack>
        {notice('n1')}
        {notice('n2')}
        {notice('n3')}
      </ChatNoticeStack>,
    )
    await waitFor(() => {
      expect(pagerIn('n3')).toBeTruthy()
    })
    expect(screen.getByTestId('chat-notice-stack-page').textContent).toBe('3/3')
    await waitFor(() => {
      expect(isHidden(screen.getByTestId('n3'))).toBe(false)
      expect(isHidden(screen.getByTestId('n1'))).toBe(true)
      expect(isHidden(screen.getByTestId('n2'))).toBe(true)
    })
  })

  it('左右箭头翻历史：◀ 看更早，▶ 看更新', async () => {
    render(
      <ChatNoticeStack>
        {notice('n1')}
        {notice('n2')}
      </ChatNoticeStack>,
    )
    await screen.findByTestId('chat-notice-stack-page')
    expect(pagerIn('n2')).toBeTruthy()
    expect(screen.getByTestId('chat-notice-stack-page').textContent).toBe('2/2')

    act(() => {
      fireEvent.click(screen.getByTestId('chat-notice-stack-prev'))
    })
    await waitFor(() => {
      expect(pagerIn('n1')).toBeTruthy()
      expect(screen.getByTestId('chat-notice-stack-page').textContent).toBe('1/2')
      expect(isHidden(screen.getByTestId('n1'))).toBe(false)
      expect(isHidden(screen.getByTestId('n2'))).toBe(true)
    })

    act(() => {
      fireEvent.click(screen.getByTestId('chat-notice-stack-next'))
    })
    await waitFor(() => {
      expect(pagerIn('n2')).toBeTruthy()
      expect(screen.getByTestId('chat-notice-stack-page').textContent).toBe('2/2')
      expect(isHidden(screen.getByTestId('n2'))).toBe(false)
    })
  })

  it('动态新增通知：observer 兜底并跳到最新页', async () => {
    const Harness: React.FC = () => {
      const hostRef = useRef<HTMLDivElement>(null)
      const addNotice = () => {
        const el = document.createElement('div')
        el.setAttribute('data-chat-notice', '')
        el.setAttribute('data-testid', 'a3')
        el.textContent = 'a3'
        hostRef.current?.appendChild(el)
      }
      return (
        <>
          <button data-testid="add" onClick={addNotice}>
            add
          </button>
          <ChatNoticeStack>
            <div ref={hostRef}>
              {notice('a1')}
              {notice('a2')}
            </div>
          </ChatNoticeStack>
        </>
      )
    }
    render(<Harness />)
    await waitFor(() => {
      expect(pagerIn('a2')).toBeTruthy()
    })

    act(() => {
      fireEvent.click(screen.getByTestId('chat-notice-stack-prev'))
    })
    await waitFor(() => {
      expect(pagerIn('a1')).toBeTruthy()
      expect(screen.getByTestId('chat-notice-stack-page').textContent).toBe('1/2')
    })

    act(() => {
      fireEvent.click(screen.getByTestId('add'))
    })
    await waitFor(() => {
      expect(pagerIn('a3')).toBeTruthy()
      expect(screen.getByTestId('chat-notice-stack-page').textContent).toBe('3/3')
      expect(isHidden(screen.getByTestId('a3'))).toBe(false)
    })
  })
})
