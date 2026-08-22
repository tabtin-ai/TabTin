import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'admin.fieldRecycleBin.title': '已删除字段',
        'admin.fieldRecycleBin.description': `保留期内的已删除字段可在此恢复。超过 ${opts?.days ?? 30} 天将被永久清理。`,
        'admin.fieldRecycleBin.empty': '暂无已删除字段',
        'admin.fieldRecycleBin.loading': '加载中…',
        'admin.fieldRecycleBin.loadFailed': '加载失败',
        'admin.fieldRecycleBin.restoreAction': '恢复字段',
        'admin.fieldRecycleBin.restoreSuccess': `字段「${opts?.name ?? ''}」已恢复。`,
        'admin.fieldRecycleBin.restoreFailed': `恢复失败：${opts?.reason ?? ''}`,
        'admin.fieldRecycleBin.refresh': '刷新',
        'admin.fieldRecycleBin.ttlHint': `字段删除后保留 ${opts?.days ?? 30} 天，超期后永久清理。`,
        'admin.fieldRecycleBin.daysRemainingValue': `${opts?.days ?? 0} 天`,
      }
      return map[key] ?? key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', async () => {
  const React = await import('react')
  return {
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
    DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
    Button: ({ children, onClick, disabled, variant, size, className }: any) =>
      React.createElement('button', { onClick, disabled, className }, children),
    ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) =>
      React.createElement('div', { className }, children),
    toast: vi.fn(),
    cn: (...args: any[]) => args.filter(Boolean).join(' '),
    PanelLoadingState: ({ message }: { message: string }) =>
      React.createElement('div', { 'data-testid': 'loading' }, message),
    StatusNotice: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'error' }, children),
    Badge: ({ children, variant, className }: any) =>
      React.createElement('span', { 'data-variant': variant, className }, children),
  }
})

const mockApiRequest = vi.fn()
const mockGetAuthToken = vi.fn().mockResolvedValue('test-token')

vi.mock('@/adapters/api-adapter-instance', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getAuthToken: () => mockGetAuthToken(),
}))

vi.mock('@/config/api', () => ({
  API_CONFIG: { baseURL: 'http://test' },
}))

import { FieldRecycleBin } from './FieldRecycleBin'

describe('FieldRecycleBin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders dialog title when open', async () => {
    mockApiRequest.mockResolvedValue({
      data: { table_id: 'tbl-1', fields: [], ttl_days: 30 },
    })
    render(
      <FieldRecycleBin
        isOpen={true}
        onClose={() => {}}
        tableId="tbl-1"
        tableName="Test Table"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('已删除字段')).toBeTruthy()
    })
  })

  it('does not render when closed', () => {
    render(
      <FieldRecycleBin
        isOpen={false}
        onClose={() => {}}
        tableId="tbl-1"
      />,
    )
    expect(screen.queryByText('已删除字段')).toBeNull()
  })

  it('shows empty state when no deleted fields', async () => {
    mockApiRequest.mockResolvedValue({
      data: { table_id: 'tbl-1', fields: [], ttl_days: 30 },
    })
    render(
      <FieldRecycleBin
        isOpen={true}
        onClose={() => {}}
        tableId="tbl-1"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('暂无已删除字段')).toBeTruthy()
    })
  })

  it('renders deleted fields list', async () => {
    mockApiRequest.mockResolvedValue({
      data: {
        table_id: 'tbl-1',
        fields: [
          {
            id: 'fld-1',
            name: '销售额',
            field_type: 'number',
            is_deleted: true,
            deleted_at: '2026-04-15T10:00:00Z',
            days_remaining: 27,
            config: {},
          },
          {
            id: 'fld-2',
            name: '备注',
            field_type: 'text',
            is_deleted: true,
            deleted_at: '2026-04-16T10:00:00Z',
            days_remaining: 28,
            config: {},
          },
        ],
        ttl_days: 30,
      },
    })
    render(
      <FieldRecycleBin
        isOpen={true}
        onClose={() => {}}
        tableId="tbl-1"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('销售额')).toBeTruthy()
      expect(screen.getByText('备注')).toBeTruthy()
    })
  })

  it('shows field type badge', async () => {
    mockApiRequest.mockResolvedValue({
      data: {
        table_id: 'tbl-1',
        fields: [
          {
            id: 'fld-1',
            name: '金额',
            field_type: 'number',
            is_deleted: true,
            deleted_at: '2026-04-15T10:00:00Z',
            days_remaining: 25,
            config: {},
          },
        ],
        ttl_days: 30,
      },
    })
    render(
      <FieldRecycleBin
        isOpen={true}
        onClose={() => {}}
        tableId="tbl-1"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('Number')).toBeTruthy()
    })
  })

  it('shows restore button for each field', async () => {
    mockApiRequest.mockResolvedValue({
      data: {
        table_id: 'tbl-1',
        fields: [
          {
            id: 'fld-1',
            name: '字段A',
            field_type: 'text',
            is_deleted: true,
            deleted_at: '2026-04-15T10:00:00Z',
            days_remaining: 20,
            config: {},
          },
        ],
        ttl_days: 30,
      },
    })
    render(
      <FieldRecycleBin
        isOpen={true}
        onClose={() => {}}
        tableId="tbl-1"
      />,
    )
    await waitFor(() => {
      expect(screen.getByText('恢复字段')).toBeTruthy()
    })
  })

  it('shows error state on fetch failure', async () => {
    mockApiRequest.mockRejectedValueOnce(new Error('Network error'))
    render(
      <FieldRecycleBin
        isOpen={true}
        onClose={() => {}}
        tableId="tbl-1"
      />,
    )
    await waitFor(() => {
      expect(screen.getByTestId('error')).toBeTruthy()
    })
  })
})
