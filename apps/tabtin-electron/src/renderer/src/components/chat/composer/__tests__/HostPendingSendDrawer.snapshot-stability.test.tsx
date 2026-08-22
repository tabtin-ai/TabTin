/**
 * React 19 + zustand：HostPending 非空时 selector 不得造新数组。
 * 回归抽屉 Maximum update depth（ queued 路径）。
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { create } from 'zustand'
import type { HostPendingSendItem } from '@/stores/chat/messages/hostPending/hostPendingSendSlice'

const EMPTY: HostPendingSendItem[] = []

const item: HostPendingSendItem = {
  runId: 'run-1',
  sessionId: 'session-1',
  queuePosition: 1,
  createdAt: '2026-08-07T00:00:00.000Z',
  userMessage: {
    id: 'msg-1',
    role: 'user',
    content: '排队中的消息',
    created_at: '2026-08-07T00:00:00.000Z',
  } as HostPendingSendItem['userMessage'],
  titleText: '排队中的消息',
}

type ChatSlice = {
  hostPendingSendsBySessionId: Record<string, HostPendingSendItem[] | undefined>
  interruptAndPromoteHostPending: (sessionId: string, runId: string) => Promise<void>
  cancelHostPendingSend: (sessionId: string, runId: string) => Promise<boolean>
  editHostPendingSend: (sessionId: string, runId: string) => Promise<boolean>
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number; defaultValue?: string }) =>
      opts?.defaultValue?.replace('{{count}}', String(opts.count ?? '')) ?? key,
  }),
}))

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
  },
}))

const useMockChatStore = create<ChatSlice>(() => ({
  hostPendingSendsBySessionId: { 'session-1': [item] },
  interruptAndPromoteHostPending: vi.fn(async () => {}),
  cancelHostPendingSend: vi.fn(async () => true),
  editHostPendingSend: vi.fn(async () => true),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: (selector: (s: ChatSlice) => unknown) => useMockChatStore(selector),
}))

describe('HostPendingSendDrawer snapshot stability', () => {
  it('selector 内 filter 非空队列会 Maximum update depth', () => {
    function Broken({ sessionId }: { sessionId: string }) {
      const queue = useMockChatStore((s) => {
        const all = s.hostPendingSendsBySessionId[sessionId] ?? EMPTY
        const queued = all.filter((entry) => entry.queuePosition >= 1)
        return queued.length > 0 ? queued : EMPTY
      })
      return <div data-testid="count">{queue.length}</div>
    }

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Broken sessionId="session-1" />)).toThrow(
      /Maximum update depth exceeded|getSnapshot/i,
    )
    spy.mockRestore()
  })

  it('直接订 store 数组引用可渲染非空抽屉', async () => {
    const { HostPendingSendDrawer } = await import('../HostPendingSendDrawer')
    expect(() => render(<HostPendingSendDrawer sessionId="session-1" />)).not.toThrow()
    expect(screen.getByText(/1 条消息排队中/)).toBeTruthy()
    expect(screen.getByText('排队中的消息')).toBeTruthy()
  })

  it('行内暴露编辑 / 立即发送 / 移除三按钮', async () => {
    const { HostPendingSendDrawer } = await import('../HostPendingSendDrawer')
    render(<HostPendingSendDrawer sessionId="session-1" />)
    expect(screen.getByLabelText('撤回重新编辑')).toBeTruthy()
    expect(screen.getByLabelText('立即发送（插队）')).toBeTruthy()
    expect(screen.getByLabelText('移除')).toBeTruthy()
  })
})
