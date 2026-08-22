/**
 * ：Workspace 回收站行操作对 owner 始终可见且带「恢复 / 永久删除」文案。
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '@tabtin/app-shell'

const hoisted = vi.hoisted(() => ({
  listTrashedSpaces: vi.fn(),
  listDeactivatedAgents: vi.fn(),
  loadSpaces: vi.fn(),
  reactivateAgent: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'trashedSpaces.restore': '恢复',
        'trashedSpaces.restoring': '恢复中...',
        'trashedSpaces.permanentDelete': '永久删除',
        'trashedSpaces.adminRequired': '需要管理员操作',
        'trashedSpaces.empty': '回收站为空',
        'trashedSpaces.emptyHint': '没有被移入回收站的工作空间',
        'trashedSpaces.trashedAt': '删除于 {{date}}',
        'trashedSpaces.daysLeft': '{{days}} 天后自动删除',
        'trashedSpaces.loading': '加载中...',
        'trashedSpaces.title': '工作空间回收站',
        'trashedSpaces.subtitle': '被移入回收站的工作空间',
        'trashedSpaces.count': '{{count}} 个',
      }
      let out = dict[key]
      if (out === undefined) {
        if (typeof opts?.defaultValue === 'string') return opts.defaultValue
        return key
      }
      for (const [k, v] of Object.entries(opts ?? {})) {
        if (k === 'defaultValue') continue
        out = out.replace(new RegExp(`{{${k}}}`, 'g'), String(v))
      }
      return out
    },
  }),
}))

vi.mock('@tabtin/app-shell', async () => {
  const actual = await vi.importActual<typeof import('@tabtin/app-shell')>('@tabtin/app-shell')
  return {
    ...actual,
    ProjectApiService: {
      listTrashed: hoisted.listTrashedSpaces,
      restoreFromTrash: vi.fn(),
      permanentDeleteFromTrash: vi.fn(),
    },
    SpaceApiService: {
      listDeactivatedAgents: (...args: unknown[]) => hoisted.listDeactivatedAgents(...args),
    },
  }
})

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: {
    loadSpaces: typeof hoisted.loadSpaces
    reactivateAgent: typeof hoisted.reactivateAgent
  }) => unknown) =>
    selector({
      loadSpaces: hoisted.loadSpaces,
      reactivateAgent: hoisted.reactivateAgent,
    }),
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type = 'button',
  }: React.PropsWithChildren<{
    onClick?: React.MouseEventHandler<HTMLButtonElement>
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  ConfirmDialog: () => null,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <div role="tooltip">{children}</div>,
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  toast: vi.fn(),
}))

vi.mock('../../SettingsPanelHeader', () => ({
  SettingsPanelHeader: () => null,
}))

vi.mock('../../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))

vi.mock('../../SettingsSection', () => ({
  SettingsSection: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))

import { OrganizationTrashedSpacesPanel } from '../OrganizationTrashedSpacesPanel'

const org = { id: 'org-1', name: 'Test Org' } as Organization

const trashedSpace = {
  id: 'space-1',
  name: '旧工作区',
  trashed_at: '2026-07-20T00:00:00.000Z',
}

describe('OrganizationTrashedSpacesPanel · 行操作可见性 ', () => {
  beforeEach(() => {
    hoisted.listTrashedSpaces.mockReset()
    hoisted.listDeactivatedAgents.mockReset()
    hoisted.listTrashedSpaces.mockResolvedValue({ items: [trashedSpace] })
    hoisted.listDeactivatedAgents.mockResolvedValue({ items: [], total: 0 })
  })

  it('owner 时始终展示带文案的恢复 / 永久删除按钮', async () => {
    render(
      <OrganizationTrashedSpacesPanel
        organization={org}
        canManageOrganization
        embedded
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('旧工作区')).toBeTruthy()
    })

    expect(screen.getByRole('button', { name: /恢复/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /永久删除/ })).toBeTruthy()
  })

  it('非 owner 仍显示恢复 / 永久删除，但置灰并提示需管理员', async () => {
    render(
      <OrganizationTrashedSpacesPanel
        organization={org}
        canManageOrganization={false}
        embedded
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('旧工作区')).toBeTruthy()
    })

    const restore = screen.getByRole('button', { name: /恢复/ }) as HTMLButtonElement
    const remove = screen.getByRole('button', { name: /永久删除/ }) as HTMLButtonElement
    expect(restore.disabled).toBe(true)
    expect(remove.disabled).toBe(true)
    expect(screen.getAllByRole('tooltip').some((el) => el.textContent === '需要管理员操作')).toBe(true)
  })
})
