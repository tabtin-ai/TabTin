import React from 'react'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ViewRecordsResponse } from '@tabtin/table-core'
import {
  collectViewRecordIds,
  RecordCommentCountBadge,
  ViewRecordCommentCountsProvider,
} from './RecordCommentCountBadge'

const { mockUseRecordCommentCounts } = vi.hoisted(() => ({
  mockUseRecordCommentCounts: vi.fn(),
}))

vi.mock('@components/table/hooks/useRecordCommentCounts', () => ({
  useRecordCommentCounts: mockUseRecordCommentCounts,
}))

vi.mock('@components/table/TableCollabContext', () => ({
  useTableCollab: () => ({
    collabBridge: {
      collab: {
        onStatelessEvent: vi.fn(() => () => undefined),
      },
    },
  }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { count?: number }) => `${options?.count ?? 0} comments`,
  }),
}))

describe('RecordCommentCountBadge', () => {
  beforeEach(() => {
    mockUseRecordCommentCounts.mockReset()
    mockUseRecordCommentCounts.mockReturnValue({
      counts: {},
      loading: false,
      error: null,
    })
  })

  it('collects loaded records across flat, calendar wrapper, and kanban group payloads', () => {
    const viewRecords = {
      records: [
        { id: 'gallery-record' },
        { record: { id: 'calendar-record' } },
        { id: 'shared-record' },
      ],
      metadata: {
        groups: [
          { records: [{ id: 'kanban-record' }, { id: 'shared-record' }] },
          { records: [{ __id: 'loaded-later-record' }] },
        ],
      },
    } as unknown as ViewRecordsResponse

    expect(collectViewRecordIds(viewRecords)).toEqual([
      'gallery-record',
      'calendar-record',
      'shared-record',
      'kanban-record',
      'loaded-later-record',
    ])
  })

  it('renders the same positive count for every consuming view and hides zero counts', () => {
    mockUseRecordCommentCounts.mockReturnValue({
      counts: { discussed: 3, silent: 0 },
      loading: false,
      error: null,
    })

    render(
      <ViewRecordCommentCountsProvider
        tableId="table-1"
        viewRecords={
          {
            records: [{ id: 'discussed' }, { id: 'silent' }],
          } as unknown as ViewRecordsResponse
        }
        enabled
      >
        <div data-testid="kanban">
          <RecordCommentCountBadge recordId="discussed" />
        </div>
        <div data-testid="gallery">
          <RecordCommentCountBadge recordId="discussed" />
        </div>
        <div data-testid="calendar">
          <RecordCommentCountBadge recordId="discussed" />
        </div>
        <div data-testid="flashcard">
          <RecordCommentCountBadge recordId="discussed" />
        </div>
        <div data-testid="zero">
          <RecordCommentCountBadge recordId="silent" />
        </div>
      </ViewRecordCommentCountsProvider>,
    )

    expect(screen.getAllByLabelText('3 comments')).toHaveLength(4)
    expect(screen.getByTestId('zero')).toBeEmptyDOMElement()
    expect(mockUseRecordCommentCounts).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: 'table-1',
        recordIds: ['discussed', 'silent'],
        enabled: true,
      }),
    )
  })

  it('opens the record comments when the badge is clicked without bubbling to the card', () => {
    mockUseRecordCommentCounts.mockReturnValue({
      counts: { discussed: 2 },
      loading: false,
      error: null,
    })
    const onOpenRecordComments = vi.fn()
    const onCardClick = vi.fn()

    render(
      <ViewRecordCommentCountsProvider
        tableId="table-1"
        viewRecords={
          {
            records: [{ id: 'discussed' }],
          } as unknown as ViewRecordsResponse
        }
        enabled
        onOpenRecordComments={onOpenRecordComments}
      >
        <div onClick={onCardClick}>
          <RecordCommentCountBadge recordId="discussed" />
        </div>
      </ViewRecordCommentCountsProvider>,
    )

    fireEvent.click(screen.getByRole('button', { name: '2 comments' }))

    expect(onOpenRecordComments).toHaveBeenCalledWith('discussed')
    expect(onCardClick).not.toHaveBeenCalled()
  })

  it.each(['KanbanView.tsx', 'GalleryView.tsx', 'CalendarView.tsx', 'FlashcardView.tsx'])(
    'wires the shared badge into %s',
    (filename) => {
      const source = readFileSync(new URL(filename, import.meta.url), 'utf8')
      expect(source).toContain('<RecordCommentCountBadge')
    },
  )
})
