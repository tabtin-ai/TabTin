/**
 * @vitest-environment jsdom
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RemoteAgentBanner } from '../RemoteAgentBanner'

const selectSpaceBySpaceId = vi.hoisted(() => vi.fn(() => true))
const ensureLocalWorkspaceForOrganization = vi.hoisted(() => vi.fn(async () => undefined))
const listLocalWorkspaces = vi.hoisted(() =>
  vi.fn(() => [] as Array<{ id: string; name: string; is_default?: boolean }>),
)

const spaceState = vi.hoisted(() => ({
  spaces: [{ id: 'local-1', name: '默认工作空间' }],
  selectedSpace: { id: 'remote-1' } as { id: string } | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const template = opts?.defaultValue ?? key
      if (!opts) return template
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => opts[name] ?? `{{${name}}}`)
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick, disabled, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
  } & React.HTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: typeof spaceState) => unknown) => selector(spaceState),
    { getState: () => spaceState },
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: unknown) => unknown) =>
    selector({ selectedOrganization: { id: 'org-1' } }),
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ currentDevice: { id: 'dev-local' } }),
    { getState: () => ({ currentDevice: { id: 'dev-local' } }) },
  ),
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({ selectSpaceBySpaceId }),
  },
}))

vi.mock('@components/sidebar/ensureLocalWorkspace', () => ({
  ensureLocalWorkspaceForOrganization,
  listLocalWorkspaces,
}))

vi.mock('@utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

describe('RemoteAgentBanner local switch', () => {
  beforeEach(() => {
    selectSpaceBySpaceId.mockClear()
    ensureLocalWorkspaceForOrganization.mockClear()
    listLocalWorkspaces.mockReset()
    // mockReset 后默认返回 undefined；显式钉空列表，避免上条用例的 mockReturnValue 泄漏
    listLocalWorkspaces.mockReturnValue([])
    spaceState.spaces = [{ id: 'local-1', name: '默认工作空间' }]
    spaceState.selectedSpace = { id: 'remote-1' }
  })

  it('有本机工作空间时主按钮切到默认，多选时露出下拉', async () => {
    listLocalWorkspaces.mockReturnValue([
      { id: 'local-1', name: '默认工作空间', is_default: true },
      { id: 'local-2', name: '另一个本机', is_default: false },
    ])

    render(
      <RemoteAgentBanner
        controlDeviceName="Remote-Studio.local (darwin)"
        appLabel="浏览器"
      />,
    )

    expect(screen.getByTestId('remote-agent-switch-local').textContent).toContain(
      '切换到「默认工作空间」',
    )
    expect(screen.getByTestId('remote-agent-switch-local-pick')).toBeTruthy()

    fireEvent.click(screen.getByTestId('remote-agent-switch-local'))

    await waitFor(() => {
      expect(selectSpaceBySpaceId).toHaveBeenCalledWith('local-1')
    })
    expect(ensureLocalWorkspaceForOrganization).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('remote-agent-switch-local-item-local-2'))

    await waitFor(() => {
      expect(selectSpaceBySpaceId).toHaveBeenCalledWith('local-2')
    })
  })

  it('无本机工作空间时走创建并切换', async () => {
    listLocalWorkspaces.mockImplementation(() => {
      if (ensureLocalWorkspaceForOrganization.mock.calls.length > 0) {
        return [{ id: 'created-1', name: '默认工作空间', is_default: true }]
      }
      return []
    })

    render(
      <RemoteAgentBanner
        controlDeviceName="Remote-Studio.local (darwin)"
        appLabel="浏览器"
      />,
    )

    expect(screen.getByTestId('remote-agent-switch-local').textContent).toContain(
      '创建本机工作空间并切换',
    )

    fireEvent.click(screen.getByTestId('remote-agent-switch-local'))

    await waitFor(() => {
      expect(ensureLocalWorkspaceForOrganization).toHaveBeenCalledWith('org-1', { force: true })
      expect(selectSpaceBySpaceId).toHaveBeenCalledWith('created-1')
    })
  })
})
