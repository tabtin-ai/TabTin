/**
 * ApprovalGrantPopover — composer「管理 Agent 权限」轻量浮层行为验证。
 *
 * 修复背景：旧入口打开全局抽屉（role="dialog"），命中 native-view-overlays
 * 的屏蔽选择器导致浏览器 WebContentsView 被整体隐藏。改成手搓浮层后，
 * 关键回归点是「浮层打开时不产生任何会触发浏览器隐藏的 DOM 标记」。
 *
 * 覆盖：
 *  1. 点击权限 pill 开合浮层，内容为共享审批档区块（stub）
 *  2. 浮层打开时 countNativeViewBlockingOverlays === 0（不藏浏览器）
 *  3. 触发器图标颜色跟随当前对话审批档
 *  4. 升档确认框打开期间，点浮层外部不关闭浮层；确认框关闭后恢复
 *  5. 无可用 spaceId 时点击 no-op
 *
 * 审批档选择本身的业务规则（session 写入 / 升档确认 / 三种锁定态）
 * 由 AgentSecurityPanel.test.tsx 经共享区块 ApprovalGrantSection 覆盖。
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { countNativeViewBlockingOverlays } from '@utils/native-view-overlays'

const { spaceState, authState, orgState, sectionProbe } = vi.hoisted(() => ({
  spaceState: {
    selectedSpace: { id: 'space-selected' } as { id: string } | null,
  },
  authState: {
    user: { id: 'user-1' } as { id: string } | null,
  },
  orgState: {
    currentUserRole: 'owner' as string | null,
    selectedOrganization: { id: 'org-1', owner_id: 'user-1' } as { id: string; owner_id: string } | null,
  },
  sectionProbe: {
    lastProps: null as null | Record<string, unknown>,
  },
}))

// framer-motion 的 AnimatePresence exit 动画在 jsdom 下是异步卸载，
// 会让「关闭后立即断言不存在」的用例不稳定——替换为同步渲染的透传实现。
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: React.forwardRef<HTMLDivElement, Record<string, unknown>>(function MotionDiv(props, ref) {
      const { initial: _i, animate: _a, exit: _e, transition: _t, ...rest } = props
      return <div ref={ref} {...(rest as React.HTMLAttributes<HTMLDivElement>)} />
    }),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opt?: { defaultValue?: string }) => opt?.defaultValue ?? key,
  }),
}))

vi.mock('@utils/cn', () => ({
  cn: (...xs: unknown[]) => xs.filter(Boolean).join(' '),
}))

vi.mock('@components/ui', () => ({
  OVERLAY_SURFACE_CLASS: 'overlay-surface',
}))

vi.mock('../../panel/ChatIconTooltip', () => ({
  ChatIconTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: typeof spaceState) => unknown) => selector(spaceState),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}))

// 需要带 subscribe/getState：真实 native-view-overlays → useUIStore →
// useSettingsSpaceStore 的模块级 useOrganizationStore.subscribe 会在 import 时执行。
vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: Object.assign(
    (selector: (state: typeof orgState) => unknown) => selector(orgState),
    {
      getState: () => orgState,
      subscribe: () => () => {},
    },
  ),
}))

vi.mock('@/hooks/useCanEditAgentSettings', () => ({
  canEditAgentSettings: (role: string | null) => role === 'owner' || role === 'admin' || role === 'editor',
}))

vi.mock('@components/space-settings/hooks/useSpaceSettingsEditGuard', () => ({
  useSpaceSettingsEditGuard: () => ({
    isRemoteViewer: false,
    isResolving: false,
    controlDeviceName: null,
    blockSettingsEdit: false,
  }),
  effectiveCanEditAgentSettings: (roleCanEdit: boolean, guard: { blockSettingsEdit: boolean }) =>
    roleCanEdit && !guard.blockSettingsEdit,
}))

vi.mock('@/stores/chat/session/sessionApprovalMode', () => ({
  useEffectiveSessionApprovalMode: (sessionId: string | null) =>
    sessionId === 'session-full-access' ? 'full_access' : 'always_ask',
}))

// 共享审批档区块 stub：真实业务规则在 AgentSecurityPanel.test.tsx 覆盖。
// 暴露一个按钮模拟「升档确认框开/关」，验证浮层的点外部关闭暂停逻辑。
vi.mock('@components/space-settings/ApprovalGrantSection', () => ({
  ApprovalGrantSection: (props: Record<string, unknown>) => {
    sectionProbe.lastProps = props
    const onConfirmOpenChange = props.onConfirmOpenChange as ((open: boolean) => void) | undefined
    return (
      <div data-testid="approval-grant-section">
        <button type="button" onClick={() => onConfirmOpenChange?.(true)}>模拟打开确认框</button>
        <button type="button" onClick={() => onConfirmOpenChange?.(false)}>模拟关闭确认框</button>
      </div>
    )
  },
}))

import { ApprovalGrantPopover } from '../ApprovalGrantPopover'

beforeEach(() => {
  vi.clearAllMocks()
  sectionProbe.lastProps = null
  spaceState.selectedSpace = { id: 'space-selected' }
  authState.user = { id: 'user-1' }
  orgState.currentUserRole = 'owner'
  orgState.selectedOrganization = { id: 'org-1', owner_id: 'user-1' }
})

function trigger(): HTMLElement {
  return screen.getByLabelText(/管理 Agent 权限/)
}

describe('ApprovalGrantPopover', () => {
  it('点击权限 pill 打开浮层并渲染共享审批档区块，再点收起', () => {
    render(<ApprovalGrantPopover spaceId="space-1" sessionId="session-1" />)

    expect(screen.queryByTestId('approval-grant-section')).toBeNull()
    fireEvent.click(trigger())
    expect(screen.getByTestId('approval-grant-section')).not.toBeNull()
    expect(sectionProbe.lastProps).toMatchObject({
      spaceId: 'space-1',
      sessionId: 'session-1',
      canManage: true,
      frameless: true,
      confirmDialogContainer: null,
    })

    fireEvent.click(trigger())
    expect(screen.queryByTestId('approval-grant-section')).toBeNull()
  })

  it('浮层打开时不产生触发浏览器隐藏的 DOM 标记（回归：入口不再藏浏览器）', () => {
    render(<ApprovalGrantPopover spaceId="space-1" sessionId="session-1" />)
    fireEvent.click(trigger())

    expect(screen.getByTestId('approval-grant-section')).not.toBeNull()
    expect(countNativeViewBlockingOverlays(document)).toBe(0)
  })

  it('触发器展示当前档位文字标签与着色图标', () => {
    const { unmount } = render(<ApprovalGrantPopover spaceId="space-1" sessionId="session-full-access" />)
    expect(trigger().textContent).toContain('full_access')
    expect(trigger().querySelector('svg')?.getAttribute('class')).toContain('text-destructive')
    unmount()

    render(<ApprovalGrantPopover spaceId="space-1" sessionId="session-1" />)
    expect(trigger().textContent).toContain('always_ask')
    expect(trigger().querySelector('svg')?.getAttribute('class')).toContain('text-muted-foreground')
  })

  it('compact：与其它下拉触发器一致只留图标，档位名进 aria-label（胶囊）', () => {
    render(
      <ApprovalGrantPopover spaceId="space-1" sessionId="session-full-access" compact />,
    )
    const btn = trigger()
    expect(btn.getAttribute('data-compact')).toBe('true')
    expect(btn.textContent ?? '').not.toContain('full_access')
    expect(btn.getAttribute('aria-label')).toContain('full_access')
    expect(btn.querySelectorAll('svg')).toHaveLength(1)
    expect(screen.queryByTestId('approval-grant-chevron')).toBeNull()
  })

  it('挂在 data-agent-chat-overlay 内时自动收字；侧栏（无该祖先）保持全文', () => {
    const { unmount } = render(
      <div data-agent-chat-overlay>
        <ApprovalGrantPopover spaceId="space-1" sessionId="session-full-access" />
      </div>,
    )
    expect(trigger().getAttribute('data-compact')).toBe('true')
    expect(trigger().textContent ?? '').not.toContain('full_access')
    unmount()

    render(<ApprovalGrantPopover spaceId="space-1" sessionId="session-full-access" />)
    expect(trigger().getAttribute('data-compact')).toBeNull()
    expect(trigger().textContent).toContain('full_access')
  })

  it('升档确认框打开期间点外部不关闭浮层，确认框关闭后恢复', () => {
    render(<ApprovalGrantPopover spaceId="space-1" sessionId="session-1" />)
    fireEvent.click(trigger())

    fireEvent.click(screen.getByText('模拟打开确认框'))
    act(() => {
      fireEvent.mouseDown(document.body)
    })
    expect(screen.getByTestId('approval-grant-section')).not.toBeNull()

    fireEvent.click(screen.getByText('模拟关闭确认框'))
    act(() => {
      fireEvent.mouseDown(document.body)
    })
    expect(screen.queryByTestId('approval-grant-section')).toBeNull()
  })

  it('spaceId 缺省回退到当前选中 Space；两者都没有时点击 no-op', () => {
    const { unmount } = render(<ApprovalGrantPopover spaceId={null} sessionId="session-1" />)
    fireEvent.click(trigger())
    expect(sectionProbe.lastProps).toMatchObject({ spaceId: 'space-selected' })
    unmount()

    spaceState.selectedSpace = null
    render(<ApprovalGrantPopover spaceId={null} sessionId="session-1" />)
    fireEvent.click(trigger())
    expect(screen.queryByTestId('approval-grant-section')).toBeNull()
  })
})
