/**
 * 个人回收站：列表项始终展示可点的「恢复 / 永久删除」（不再按组织 admin 锁按钮）。
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '@tabtin/app-shell'

const hoisted = vi.hoisted(() => ({
  listOrganizationTrashedItems: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const dict: Record<string, string> = {
        'resourceTrash.restore': '恢复',
        'resourceTrash.permanentDelete': '永久删除',
        'resourceTrash.empty': '回收站为空',
        'resourceTrash.emptyHint': '你删除的资源将在此保留 30 天',
        'resourceTrash.loading': '加载中...',
        'resourceTrash.untitled': '无标题',
        'resourceTrash.trashedAt': '删除于 {{time}}',
        'resourceTrash.daysLeft': '{{days}} 天后自动删除',
        'resourceTrash.itemCount': '{{count}} 个项目',
        'resourceTrash.refresh': '刷新',
        'resourceTrash.title': '资源回收站',
        'resourceTrash.subtitle': '仅显示你在本组织删除的资源',
        'resourceTrash.itemTypes.tabdoc': '文档',
        'resourceTrash.emptyTrash': '清空回收站',
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
    SpaceApiService: {
      listOrganizationTrashedItems: hoisted.listOrganizationTrashedItems,
      emptyOrganizationTrash: vi.fn(),
    },
  }
})

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
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: vi.fn(),
  getAuthToken: vi.fn(async () => null),
}))

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'http://localhost:6060' },
}))

vi.mock('@/components/context-space/registry/instance', () => ({
  contextRegistry: {
    normalizeBackendType: (type: string) => type,
  },
}))

vi.mock('../../SettingsPanelHeader', () => ({
  SettingsPanelHeader: () => null,
}))

vi.mock('../../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))

import { OrganizationResourceTrashPanel } from '../OrganizationResourceTrashPanel'

const org = { id: 'org-1', name: 'Test Org' } as Organization

const trashedItem = {
  id: 'item-1',
  title: '草稿文档',
  item_type: 'tabdoc',
  resource_id: 'doc-1',
  space_id: 'space-1',
  trashed_at: '2026-07-20T00:00:00.000Z',
  updated_at: '2026-07-20T00:00:00.000Z',
}

describe('OrganizationResourceTrashPanel · 个人回收站操作', () => {
  beforeEach(() => {
    hoisted.listOrganizationTrashedItems.mockReset()
    hoisted.listOrganizationTrashedItems.mockResolvedValue({ items: [trashedItem] })
  })

  it('始终展示可点击的恢复 / 永久删除（不因组织角色锁按钮）', async () => {
    render(
      <OrganizationResourceTrashPanel
        organization={org}
        canManageOrganization={false}
        embedded
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('草稿文档')).toBeTruthy()
    })

    const restore = screen.getByRole('button', { name: /恢复/ }) as HTMLButtonElement
    const remove = screen.getByRole('button', { name: /永久删除/ }) as HTMLButtonElement
    expect(restore.disabled).toBe(false)
    expect(remove.disabled).toBe(false)
  })
})
