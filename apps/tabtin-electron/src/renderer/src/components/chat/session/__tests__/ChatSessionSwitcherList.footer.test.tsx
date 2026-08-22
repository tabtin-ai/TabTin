import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ChatSessionSwitcherList } from '../ChatSessionSwitcherList'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  ChatHistorySkeleton: () => <div data-testid="skeleton" />,
}))

vi.mock('../SessionListVirtualRow', () => ({
  SessionListVirtualRow: () => <div data-testid="virtual-row" />,
}))

describe('ChatSessionSwitcherList listFooter 滚动区', () => {
  it('listFooter 渲染在虚拟列表滚动区内，随列表一起滚动', () => {
    const parentRef = { current: null as HTMLDivElement | null }
    const virtualizer = {
      getTotalSize: () => 0,
      measureElement: vi.fn(),
      getVirtualItems: () => [],
    }

    render(
      <ChatSessionSwitcherList
        isTrackerRunsOnly={false}
        isLoading={false}
        isDraftActive={false}
        flatListItems={[{ type: 'session', key: 's-1', sessionId: 's-1', label: 'Demo' } as never]}
        listFooter={<div data-testid="scroll-footer">自动化区</div>}
        newConversationEntry={null}
        listParentRef={parentRef}
        virtualizer={virtualizer as never}
        virtualItems={[]}
        virtualRowProps={{} as never}
        t={(key, opts) => (opts?.defaultValue as string) ?? key}
      />,
    )

    const scrollArea = parentRef.current
    expect(scrollArea).not.toBeNull()
    expect(scrollArea?.className).toContain('overflow-y-auto')
    expect(screen.getByTestId('scroll-footer')).toBeTruthy()
    expect(screen.queryByTestId('chat-session-switcher-list-footer')).toBeNull()
  })
})
