import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { OnlinePresencePopover } from '../OnlinePresencePopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => {
      const template = options?.defaultValue ?? key
      return template.replace('{{count}}', String(options?.count ?? ''))
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  UserAvatar: ({ name }: { name: string }) => <span>{name}</span>,
}))

vi.mock('@tabtin/shared', () => ({
  identityAvatarColor: () => '#000',
  identityAvatarInitial: (name: string) => (name || '?').slice(0, 1),
}))

describe('OnlinePresencePopover', () => {
  it('hides when offline', () => {
    const { container } = render(
      <OnlinePresencePopover
        isOnline={false}
        peers={[{ id: 'p1', name: 'Alice' }]}
        self={{ id: 'me', name: 'Me' }}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows online count including self', () => {
    render(
      <OnlinePresencePopover
        isOnline
        peers={[{ id: 'p1', name: 'Alice' }]}
        self={{ id: 'me', name: 'Me' }}
      />,
    )
    expect(screen.getByText('2 人在线')).toBeTruthy()
    expect(screen.getByText('当前在线（2）')).toBeTruthy()
  })

  it('shows overflow trigger when participants exceed maxInline', () => {
    render(
      <OnlinePresencePopover
        isOnline
        maxInline={2}
        peers={[
          { id: 'p1', name: 'Alice' },
          { id: 'p2', name: 'Bob' },
          { id: 'p3', name: 'Carol' },
        ]}
        self={{ id: 'me', name: 'Me' }}
      />,
    )
    // 4 人在线，maxInline=2：内联头像占 1 槽，溢出按钮占 1 槽 → 隐藏 3 人
    expect(screen.getByLabelText('还有 3 人在线，展开全部')).toBeTruthy()
    fireEvent.focus(screen.getByLabelText('还有 3 人在线，展开全部'))
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Carol').length).toBeGreaterThan(0)
    expect(screen.queryByText('Agent')).toBeNull()
  })

  it('keeps overflow count equal to hidden participants for maxInline=1', () => {
    render(
      <OnlinePresencePopover
        isOnline
        maxInline={1}
        peers={[
          { id: 'p1', name: 'Alice' },
          { id: 'p2', name: 'Bob' },
        ]}
        self={{ id: 'me', name: 'Me' }}
      />,
    )
    // maxInline=1：内联容量为 0，只留溢出按钮，隐藏人数=全部 3 人
    expect(screen.getByLabelText('还有 3 人在线，展开全部')).toBeTruthy()
    expect(screen.getByText('3 人在线')).toBeTruthy()
  })

  it('does not negative-slice when maxInline is 0', () => {
    render(
      <OnlinePresencePopover
        isOnline
        maxInline={0}
        peers={[{ id: 'p1', name: 'Alice' }]}
        self={{ id: 'me', name: 'Me' }}
      />,
    )
    // maxInline<=0 时 inlineCapacity 钳到 0，隐藏人数=count，不触发负 slice
    expect(screen.getByLabelText('还有 2 人在线，展开全部')).toBeTruthy()
    expect(screen.getByText('2 人在线')).toBeTruthy()
  })

  it('labels agent participants', () => {
    render(
      <OnlinePresencePopover
        isOnline
        peers={[{ id: 'agent-1', name: '小Tin', type: 'agent' }]}
        self={{ id: 'me', name: 'Me' }}
      />,
    )
    expect(screen.getByText('Agent')).toBeTruthy()
  })
})
