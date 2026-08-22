import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TableRecord } from '@tabtin/table-core'
import { RecordFormContainer } from './RecordFormContainer'

const mocks = vi.hoisted(() => ({
  getRecordHistory: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  CommentsSection: () => null,
  RecordFormDialog: ({
    historyPanel,
    onHistoryToggle,
  }: {
    historyPanel?: React.ReactNode
    onHistoryToggle?: () => void
  }) => (
    <div>
      <button type="button" onClick={onHistoryToggle}>toggle-history</button>
      {historyPanel}
    </div>
  ),
  RecordHistoryPanel: ({ operations }: { operations: Array<{ record_id?: string }> }) => (
    <div data-testid="record-history">
      {operations.map((operation) => operation.record_id).join(',')}
    </div>
  ),
  useToast: () => ({ toast: vi.fn() }),
}))

vi.mock('@tabtin/table-ui', () => ({
  toFieldDefinitions: () => [],
  toOrganizationMembers: () => [],
}))

vi.mock('@tabtin/table-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/table-core')>()
  return {
    ...actual,
    UndoRedoApiService: {
      getRecordHistory: mocks.getRecordHistory,
    },
    computeChangedRecordData: vi.fn(() => ({})),
    isOutOfBandManagedField: vi.fn(() => false),
  }
})

vi.mock('@stores/useTableStore', () => ({
  useTableStore: (selector: (state: unknown) => unknown) => selector({
    selectedTable: { id: 'table-1', name: 'Table 1' },
    fields: [],
  }),
}))

vi.mock('@stores/useRecordStore', () => ({
  useRecordStore: (selector: (state: unknown) => unknown) => selector({
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    mergeIncrementalRecords: vi.fn(),
    mergeRestoredRecords: vi.fn(),
    records: [],
    latestVersion: 0,
  }),
}))

vi.mock('@stores/useViewStore', () => ({
  useViewStore: (selector: (state: unknown) => unknown) => selector({
    currentViewId: null,
    refreshCurrentView: vi.fn(),
  }),
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) => selector({ setError: vi.fn() }),
}))

vi.mock('@stores/useAttachmentStore', () => ({
  useAttachmentStore: (selector: (state: unknown) => unknown) => selector({ clearAll: vi.fn() }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: unknown) => unknown) => selector({ members: [] }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: 'user-1' } }),
}))

vi.mock('lucide-react', () => ({ MessageSquare: () => null }))
vi.mock('@/components/attachments/AttachmentField', () => ({ AttachmentField: () => null }))
vi.mock('@/components/field/LinkCellEditor', () => ({ LinkCellEditor: () => null }))
vi.mock('@/components/record/LinkedRecordFormHost', () => ({ LinkedRecordFormHost: () => null }))
vi.mock('@/components/table/utils/tableDrawerCoordinator', () => ({
  announceTableDrawerOpen: vi.fn(),
  useCloseOnOtherTableDrawerOpen: vi.fn(),
}))
vi.mock('@/components/table/TableCollabContext', () => ({ useTableCollabOptional: () => undefined }))
vi.mock('./useRecordComments', () => ({
  useRecordComments: () => ({
    comments: [],
    mentionCandidates: [],
    openThreadTotal: 0,
    threadTotal: 0,
    statusFilter: 'open',
    setStatusFilter: vi.fn(),
    updatingThreadIds: new Set(),
    resolveThread: vi.fn(),
    reopenThread: vi.fn(),
    draft: '',
    setDraft: vi.fn(),
    submit: vi.fn(),
    searchMentionCandidates: vi.fn(),
    deletingCommentIds: new Set(),
    deleteComment: vi.fn(),
    retry: vi.fn(),
    refresh: vi.fn(),
    loading: false,
    submitting: false,
    error: null,
    hasMore: false,
    loadingMore: false,
    loadMore: vi.fn(),
  }),
}))

const makeRecord = (id: string): TableRecord => ({
  id,
  table_id: 'table-1',
  data: {},
  created_at: '2026-08-16T00:00:00Z',
  updated_at: '2026-08-16T00:00:00Z',
} as TableRecord)

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => {
    resolve = resolver
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RecordFormContainer record history', () => {
  it('ignores a previous record response after navigating to another record', async () => {
    const recordAResponse = deferred<unknown>()
    const recordBResponse = deferred<unknown>()
    mocks.getRecordHistory.mockImplementation((recordId: string) => (
      recordId === 'record-a' ? recordAResponse.promise : recordBResponse.promise
    ))

    const { rerender } = render(
      <RecordFormContainer
        open
        mode="edit"
        record={makeRecord('record-a')}
        onOpenChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'toggle-history' }))
    await waitFor(() => expect(mocks.getRecordHistory).toHaveBeenCalledWith(
      'record-a',
      expect.any(Object),
    ))

    rerender(
      <RecordFormContainer
        open
        mode="edit"
        record={makeRecord('record-b')}
        onOpenChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'toggle-history' }))
    await waitFor(() => expect(mocks.getRecordHistory).toHaveBeenCalledWith(
      'record-b',
      expect.any(Object),
    ))

    await act(async () => {
      recordBResponse.resolve({
        operations: [{ id: 'history-b', record_id: 'record-b' }],
        total: 1,
        next_cursor: null,
      })
      await recordBResponse.promise
    })
    expect(screen.getByTestId('record-history').textContent).toContain('record-b')

    await act(async () => {
      recordAResponse.resolve({
        operations: [{ id: 'history-a', record_id: 'record-a' }],
        total: 1,
        next_cursor: null,
      })
      await recordAResponse.promise
    })

    expect(screen.getByTestId('record-history').textContent).toContain('record-b')
    expect(screen.getByTestId('record-history').textContent).not.toContain('record-a')
  })
})
