/**
 * RichFile tabScopeKey 透传回归测试
 *
 * 背景：会话标签分桶（commit 2cf34bade）落地后，聊天里的资源入口必须把
 * 当前 `tabScopeKey`（如 `conversation:${sessionId}`）透传给 ResourceRouter，
 * 否则 `openResourceTab` 会落到 legacy `spaceId` 桶——而会话态 UI 渲染的是
 * `conversation:*` 桶，导致点击文件产物「打不开」。
 *
 * MarkdownRenderer 链接已在 ResourceLink.e2e.test.tsx 覆盖；本文件补齐
 * RichFile 文件产物卡片这条曾遗漏的链路（点击主体 + auto_open）。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { RichContentBlock } from '@tabtin/chat-client'

const routerOpen = vi.fn(async (
  _spaceId: string,
  _pointer: unknown,
  _options: { tabScopeKey?: string },
) => ({
  outcome: 'in_space_opened',
  carrierAppId: 'tabfiles',
  resolveSource: 'manifest_default',
  durationMs: 0,
}))

const mockVirtualModule = vi.mock as unknown as (
  path: string,
  factory: () => unknown,
  options: { virtual: boolean },
) => void
mockVirtualModule('@tabtin/resource-router', () => ({
  parseResourcePointer: (href: string) => ({
    scheme: 'tabtin',
    type: 'file',
    id: href,
    raw: href,
    hint: 'tabfiles',
    meta: {},
  }),
}), { virtual: true })

vi.mock('@/services/resourceRouter', () => ({
  wireResourceRouter: vi.fn(),
  resourceRouter: {
    open: (...args: [string, unknown, { tabScopeKey?: string }]) => routerOpen(...args),
  },
}))

let selectedSpaceId: string | null = 'space-test'

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ selectedSpace: selectedSpaceId ? { id: selectedSpaceId } : null }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign((selector: (state: unknown) => unknown) => selector({
    selectedSpace: selectedSpaceId ? { id: selectedSpaceId, type: 'workspace', execution_agent_id: 'agent-test' } : null,
    spaces: [
      { id: 'space-test', type: 'workspace', execution_agent_id: 'agent-test' },
      { id: 'space-session', type: 'workspace', execution_agent_id: 'agent-session' },
    ],
    selectedAgent: { id: 'agent-test', control_device_id: 'dev-A', working_dir: '/Users/me/space' },
    agentCache: {
      'agent-test': { id: 'agent-test', control_device_id: 'dev-A', working_dir: '/Users/me/space' },
      'agent-session': { id: 'agent-session', control_device_id: 'dev-A', working_dir: '/Users/me/session' },
    },
  }), {
    getState: () => ({
      selectedSpace: selectedSpaceId ? { id: selectedSpaceId, type: 'workspace', execution_agent_id: 'agent-test' } : null,
      spaces: [
        { id: 'space-test', type: 'workspace', execution_agent_id: 'agent-test' },
        { id: 'space-session', type: 'workspace', execution_agent_id: 'agent-session' },
      ],
      selectedAgent: { id: 'agent-test', control_device_id: 'dev-A', working_dir: '/Users/me/space' },
      agentCache: {
        'agent-test': { id: 'agent-test', control_device_id: 'dev-A', working_dir: '/Users/me/space' },
        'agent-session': { id: 'agent-session', control_device_id: 'dev-A', working_dir: '/Users/me/session' },
      },
    }),
  }),
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (selector: (state: unknown) => unknown) => selector({
    currentDevice: { id: 'dev-A' },
    devices: [{ id: 'dev-A', name: 'This Mac' }],
  }),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      draftExecutionSpaceIdByWorkspaceKey: {},
      getSessionById: (sessionId: string) =>
        sessionId === 'session-1'
          ? { id: 'session-1', space_id: 'space-session' }
          : undefined,
    }),
  },
}))

import { RichFile } from '../RichFile'
import { ResourceOpenExecutionSpaceContext } from '../../panel/ResourceOpenExecutionSpaceContext'

const fileBlock = {
  type: 'rich_content',
  kind: 'file',
  summary: '99乘法表',
  artifact_kind: 'local_file',
  relative_path: 'artifacts/99乘法表.pptx',
  filename: '99乘法表.pptx',
  file_type: 'pptx',
  mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as unknown as RichContentBlock

beforeEach(() => {
  routerOpen.mockClear()
  selectedSpaceId = 'space-test'
})

describe('RichFile tabScopeKey 透传（ 回归）', () => {
  it('点击卡片主体时把 tabScopeKey 透传给 ResourceRouter', () => {
    const { getByTestId } = render(
      <RichFile block={fileBlock} tabScopeKey="conversation:session-1" />,
    )

    fireEvent.click(getByTestId('rich-file-card'))

    expect(routerOpen).toHaveBeenCalledTimes(1)
    const [spaceId, , opts] = routerOpen.mock.calls[0]
    expect(spaceId).toBe('space-session')
    expect((opts as { tabScopeKey?: string }).tabScopeKey).toBe('conversation:session-1')
  })

  it('未提供 tabScopeKey 时升到前台 desktop scope', () => {
    const { getByTestId } = render(<RichFile block={fileBlock} />)

    fireEvent.click(getByTestId('rich-file-card'))

    expect(routerOpen).toHaveBeenCalledTimes(1)
    const [, , opts] = routerOpen.mock.calls[0]
    expect((opts as { tabScopeKey?: string }).tabScopeKey).toBe(
      'desktop:organization:unknown-organization:user:anonymous',
    )
  })

  it('auto_open 自动打开也透传 tabScopeKey', () => {
    vi.useFakeTimers()
    try {
      const autoOpenBlock = {
        ...(fileBlock as Record<string, unknown>),
        auto_open: true,
        auto_open_token: `tok-${Math.random()}`,
      } as unknown as RichContentBlock

      render(<RichFile block={autoOpenBlock} tabScopeKey="conversation:session-1" />)
      vi.runAllTimers()

      expect(routerOpen).toHaveBeenCalledTimes(1)
      const [, , opts] = routerOpen.mock.calls[0]
      expect((opts as { tabScopeKey?: string }).tabScopeKey).toBe('conversation:session-1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('IM 会话未选中全局 Space 时，auto_open 使用宿主执行 Space', () => {
    selectedSpaceId = null
    vi.useFakeTimers()
    try {
      const autoOpenBlock = {
        ...(fileBlock as Record<string, unknown>),
        auto_open: true,
        auto_open_token: `im-${Math.random()}`,
      } as unknown as RichContentBlock

      render(
        <ResourceOpenExecutionSpaceContext.Provider value="space-session">
          <RichFile block={autoOpenBlock} tabScopeKey="im:conversation-1" />
        </ResourceOpenExecutionSpaceContext.Provider>,
      )
      vi.runAllTimers()

      expect(routerOpen).toHaveBeenCalledWith(
        'space-session',
        expect.anything(),
        expect.objectContaining({ tabScopeKey: 'im:conversation-1' }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('IM 会话未选中全局 Space 时，点击卡片使用宿主执行 Space', () => {
    selectedSpaceId = null
    const { getByTestId } = render(
      <ResourceOpenExecutionSpaceContext.Provider value="space-session">
        <RichFile block={fileBlock} tabScopeKey="im:conversation-1" />
      </ResourceOpenExecutionSpaceContext.Provider>,
    )

    fireEvent.click(getByTestId('rich-file-card'))

    expect(routerOpen).toHaveBeenCalledWith(
      'space-session',
      expect.anything(),
      expect.objectContaining({ tabScopeKey: 'im:conversation-1' }),
    )
  })
})
