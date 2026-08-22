import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ViewGroupPopover,
  type GroupPanelTexts,
} from './ViewGroupPopover'

const texts: GroupPanelTexts = {
  descriptionKanban: 'Kanban supports one group',
  descriptionDefault: 'Add up to three groups',
  emptyGroupPlacement: 'Ungrouped records always appear last.',
  title: 'Groups',
  empty: 'No groups',
  add: 'Add group',
  remove: 'Remove',
  fieldPlaceholder: 'Field',
  orderAsc: 'Ascending',
  orderDesc: 'Descending',
  moveUp: 'Move up',
  moveDown: 'Move down',
  searchPlaceholder: 'Search',
  noResults: 'No results',
}

describe('ViewGroupPopover', () => {
  it('explains that the empty group is fixed at the end', () => {
    render(
      React.createElement(
        ViewGroupPopover,
        {
          open: true,
          onOpenChange: vi.fn(),
          viewId: 'view-1',
          fields: [],
          views: [{ id: 'view-1', view_type: 'grid' }],
          draft: { groups: [] },
          store: {
            initializeDraft: vi.fn(),
            setDraftGroups: vi.fn(),
            applyDraft: vi.fn(),
          },
          texts,
        },
        React.createElement('button', { type: 'button' }, 'Groups'),
      ),
    )

    expect(screen.getByRole('note').textContent).toContain(
      'Ungrouped records always appear last.',
    )
  })
})
