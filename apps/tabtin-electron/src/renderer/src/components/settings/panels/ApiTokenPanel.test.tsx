import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvailableScopesResponse } from '@tabtin/table-core'
import { ApiTokenPanel } from './ApiTokenPanel'

const {
  mockList,
  mockCreate,
  mockGetAvailableScopes,
  mockUpdate,
  mockDelete,
  mockRegenerate,
  mockToast,
  testTokenScopes,
  testScopePresets,
} = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockCreate: vi.fn(),
  mockGetAvailableScopes: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockRegenerate: vi.fn(),
  mockToast: vi.fn(),
  testTokenScopes: {
    'table:read': '读取表格',
    'table:create': '创建表格',
    'table:update': '更新表格',
    'table:delete': '删除表格',
    'record:read': '读取记录',
    'record:create': '创建记录',
    'record:update': '更新记录',
    'record:delete': '删除记录',
    'field:read': '读取字段',
    'field:create': '创建字段',
    'field:update': '更新字段',
    'field:delete': '删除字段',
    'view:read': '读取视图',
    'view:create': '创建视图',
    'view:update': '更新视图',
    'view:delete': '删除视图',
    'storage:read': '读取文件与附件',
    'storage:write': '上传与删除文件',
    'aggregation:read': '聚合查询',
    'import:write': '数据导入',
    'export:read': '数据导出',
    'webhook:manage': '管理 Webhook',
    'db_connection:manage': '管理数据库连接',
    'sql:query': 'SQL 只读查询',
    'sql:execute': 'SQL 写入执行',
    'policy:read': '读取策略',
    'policy:manage': '管理策略',
    'token:read': '读取 Token',
    'token:manage': '管理 Token',
    'connector:read': '读取连接器',
    'connector:manage': '管理连接器',
    'analytics:read': '读取分析数据',
  },
  testScopePresets: {
    readonly: {
      label: '只读',
      description: '仅读取表格、字段、记录、视图与文件，支持 SQL 只读查询',
      scopes: ['table:read', 'record:read', 'field:read', 'view:read', 'aggregation:read', 'sql:query', 'storage:read'],
    },
    readwrite: {
      label: '读写',
      description: '读写表格、记录与文件，支持导入导出和 SQL',
      scopes: [
        'table:read', 'table:create', 'table:update',
        'record:read', 'record:create', 'record:update', 'record:delete',
        'field:read', 'field:create', 'field:update',
        'view:read', 'view:create', 'view:update',
        'aggregation:read',
        'import:write', 'export:read',
        'sql:query', 'sql:execute',
        'storage:read', 'storage:write',
      ],
    },
    full: {
      label: '完全访问',
      description: '包含全部权限，包括策略、连接器与 Token 管理',
      scopes: [],
    },
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, onClick, disabled, type }: Record<string, unknown>) =>
    React.createElement('button', { onClick, disabled, type: (type as string) ?? 'button' }, children),
  Input: (props: Record<string, unknown>) => React.createElement('input', props),
  Textarea: (props: Record<string, unknown>) => React.createElement('textarea', props),
  Switch: ({ checked, onCheckedChange }: Record<string, unknown>) =>
    React.createElement('input', {
      type: 'checkbox',
      checked: Boolean(checked),
      onChange: () => (onCheckedChange as ((next: boolean) => void) | undefined)?.(!checked),
    }),
  Checkbox: ({ checked, onCheckedChange }: Record<string, unknown>) =>
    React.createElement('input', {
      type: 'checkbox',
      checked: Boolean(checked),
      onChange: () => (onCheckedChange as (() => void) | undefined)?.(),
    }),
  Dialog: ({ open, children }: Record<string, unknown>) =>
    open ? React.createElement('div', { 'data-testid': 'dialog-root' }, children) : null,
  DialogContent: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
  DialogHeader: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
  DialogTitle: ({ children }: Record<string, unknown>) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: Record<string, unknown>) => React.createElement('p', null, children),
  DialogFooter: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
  DropdownMenu: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
  DropdownMenuContent: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
  DropdownMenuItem: ({ children, onClick }: Record<string, unknown>) =>
    React.createElement('button', { onClick, type: 'button' }, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
  ConfirmDialog: () => null,
  LoadingSpinner: () => React.createElement('span', null, 'loading'),
  toast: mockToast,
  ScrollArea: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
  Skeleton: (props: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'skeleton', style: { width: props.width, height: props.height } }),
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  formatSmartTime: (value: string) => value,
}))

vi.mock('../SettingsPanelHeader', () => ({
  SettingsPanelHeader: ({ title, subtitle }: Record<string, unknown>) =>
    React.createElement('div', null, [
      React.createElement('div', { key: 'title' }, title),
      React.createElement('div', { key: 'subtitle' }, subtitle),
    ]),
}))

vi.mock('../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
}))

vi.mock('../SettingsSectionCard', () => ({
  SettingsSectionCard: ({ children }: Record<string, unknown>) => React.createElement('div', null, children),
}))

vi.mock('@tabtin/table-core', () => {
  testScopePresets.full.scopes = Object.keys(testTokenScopes)
  return {
    TOKEN_SCOPES: testTokenScopes,
    SCOPE_PRESETS: testScopePresets,
    TokenApiService: {
      list: mockList,
      create: mockCreate,
      update: mockUpdate,
      delete: mockDelete,
      regenerate: mockRegenerate,
      getAvailableScopes: mockGetAvailableScopes,
    },
  }
})

const serverScopeConfig: AvailableScopesResponse = {
  scopes: [
    {
      key: 'sql:query',
      group_key: 'sql',
      label_key: 'apiToken.scopeLabels.sqlQuery',
      default_label: 'Server SQL Query',
    },
  ],
  groups: [
    {
      key: 'sql',
      label_key: 'apiToken.scopeGroups.sql',
      default_label: 'Server SQL',
      scopes: ['sql:query'],
    },
  ],
  presets: {
    readonly: {
      label_key: 'apiToken.scopePresets.readonly.label',
      default_label: 'Server Readonly',
      description_key: 'apiToken.scopePresets.readonly.description',
      default_description: 'Server readonly preset',
      scopes: ['sql:query'],
    },
    readwrite: {
      label_key: 'apiToken.scopePresets.readwrite.label',
      default_label: 'Server Readwrite',
      description_key: 'apiToken.scopePresets.readwrite.description',
      default_description: 'Server readwrite preset',
      scopes: ['sql:query'],
    },
    full: {
      label_key: 'apiToken.scopePresets.full.label',
      default_label: 'Server Full',
      description_key: 'apiToken.scopePresets.full.description',
      default_description: 'Server full preset',
      scopes: ['sql:query'],
    },
  },
}

function renderPanel() {
  act(() => {
    render(React.createElement(ApiTokenPanel, {
      spaceId: 'space-1',
      spaceName: 'Space One',
    }))
  })
}

describe('ApiTokenPanel', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()

    mockList.mockResolvedValue([])
    mockGetAvailableScopes.mockResolvedValue(serverScopeConfig)
    mockCreate.mockResolvedValue({
      token: {
        id: 'token-1',
        name: 'Scoped Token',
        description: '',
        tokenPrefix: 'ttn_123456',
        spaceId: 'space-1',
        scopes: ['sql:query'],
        spaceIds: ['space-1'],
        tableIds: null,
        rateLimit: 60,
        expiredAt: null,
        lastUsedAt: null,
        useCount: 0,
        isActive: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
      plainToken: 'ttn_secret',
    })
  })

  it('应优先渲染服务端返回的 scope metadata', async () => {
    renderPanel()

    await waitFor(() => expect(mockGetAvailableScopes).toHaveBeenCalled())
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'apiToken.createButton' }))
    })

    expect(screen.getByText('Server Readonly')).not.toBeNull()
    expect(screen.getByText('Server readonly preset')).not.toBeNull()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'apiToken.create.custom' }))
    })

    expect(screen.getByText('Server SQL')).not.toBeNull()
    expect(screen.getByText('Server SQL Query')).not.toBeNull()
  })

  it('在 metadata 接口失败时应回退到本地 scope 配置', async () => {
    mockList.mockReset()
    mockList.mockResolvedValue([
      {
        id: 'token-fallback',
        name: 'Fallback Token',
        description: '',
        tokenPrefix: 'ttn_fallback',
        spaceId: 'space-1',
        scopes: ['sql:query'],
        spaceIds: ['space-1'],
        tableIds: null,
        rateLimit: 60,
        expiredAt: null,
        lastUsedAt: null,
        useCount: 0,
        isActive: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ])
    mockGetAvailableScopes.mockReset()
    mockGetAvailableScopes.mockRejectedValue(new Error('scope catalog failed'))
    renderPanel()

    await waitFor(() => {
      expect(mockGetAvailableScopes).toHaveBeenCalledTimes(1)
      expect(screen.queryByText('loading')).toBeNull()
      expect(screen.getByText('Fallback Token')).not.toBeNull()
    })
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'apiToken.createButton' }))
    })

    expect(screen.getByText('只读')).not.toBeNull()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'apiToken.create.custom' }))
    })

    expect(screen.getByText('SQL')).not.toBeNull()
    expect(screen.getByText('SQL 只读查询')).not.toBeNull()
  })

  it('应携带 scope_preset 与当前 Space 边界创建 token', async () => {
    renderPanel()

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'apiToken.createButton' }))
    })

    await waitFor(() => expect(screen.getByText('默认授权范围')).not.toBeNull())
    await waitFor(() => expect(screen.getByText('Server Readonly')).not.toBeNull())
    expect(screen.queryByText('改为不限制')).toBeNull()

    const nameInput = screen.getByPlaceholderText('apiToken.create.namePlaceholder')
    act(() => {
      fireEvent.change(nameInput, { target: { value: 'Scoped token' } })
      fireEvent.click(screen.getByRole('button', { name: 'apiToken.create.submit' }))
    })

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        name: 'Scoped token',
        description: '',
        scopes: ['sql:query'],
        scope_preset: 'readonly',
        space_id: 'space-1',
        space_ids: ['space-1'],
        expires_in_days: null,
      })
    })
  })

  it('后端 FK 过滤只返回当前 Space token，创建后展示一次性密钥', async () => {
    mockList.mockReset()
    mockList.mockResolvedValue([
      {
        id: 'token-space-1',
        name: 'Visible Token',
        description: '',
        tokenPrefix: 'ttn_visible',
        spaceId: 'space-1',
        scopes: ['sql:query'],
        spaceIds: ['space-1'],
        tableIds: null,
        rateLimit: 60,
        expiredAt: null,
        lastUsedAt: null,
        useCount: 0,
        isActive: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ])
    mockCreate.mockImplementationOnce(async (body: { name: string }) => ({
      token: {
        id: 'token-created',
        name: body.name,
        description: '',
        tokenPrefix: 'ttn_created',
        spaceId: 'space-1',
        scopes: ['sql:query'],
        spaceIds: ['space-1'],
        tableIds: null,
        rateLimit: 60,
        expiredAt: null,
        lastUsedAt: null,
        useCount: 0,
        isActive: true,
        createdAt: '2026-01-01T00:00:00Z',
      },
      plainToken: 'ttn_secret',
    }))

    renderPanel()

    await waitFor(() => expect(screen.getByText('Visible Token')).not.toBeNull())

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'apiToken.createButton' }))
    })

    const nameInput = screen.getByPlaceholderText('apiToken.create.namePlaceholder')
    act(() => {
      fireEvent.change(nameInput, { target: { value: 'Created Token' } })
      fireEvent.click(screen.getByRole('button', { name: 'apiToken.create.submit' }))
    })

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({
        name: 'Created Token',
        description: '',
        scopes: ['sql:query'],
        scope_preset: 'readonly',
        space_id: 'space-1',
        space_ids: ['space-1'],
        expires_in_days: null,
      })
    })

    await waitFor(() => expect(screen.getByText('apiToken.secret.title')).not.toBeNull())
    expect(screen.getByText('Created Token')).not.toBeNull()
  })
})
