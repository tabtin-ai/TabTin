import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Table } from '@tabtin/table-core'

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button {...props}>{children}</button>
  ),
  Switch: () => <button role="switch" />,
  toast: vi.fn(),
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => (key === 'table:header.personalView' ? '个人视图' : key) }),
}))

vi.mock('@components/view/ViewSwitcher', () => ({
  ViewSwitcher: () => <div data-testid="view-switcher" />,
}))

vi.mock('@stores/useTableStore', () => ({
  tableStore: { getState: () => ({ error: null }) },
  useTableStore: (selector: (state: unknown) => unknown) =>
    selector({ updateTable: vi.fn(), fields: [] }),
}))

vi.mock('@stores/useViewStore', () => ({
  useViewStore: (selector: (state: unknown) => unknown) =>
    selector({
      views: [],
      currentViewId: null,
      draftStates: {},
      updateView: vi.fn(),
      clearDraft: vi.fn(),
    }),
}))

vi.mock('@stores/useTableViewUiStore', () => ({
  useTableViewUiStore: (selector: (state: unknown) => unknown) =>
    selector({
      personalViewByScope: {},
      personalViewDraftByScope: {},
      dismissedLockedTipByScope: {},
      setPersonalViewEnabled: vi.fn(),
      clearPersonalViewDraft: vi.fn(),
      dismissLockedTip: vi.fn(),
      resetLockedTip: vi.fn(),
    }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: null }),
  selectIsAuthenticated: () => false,
}))

vi.mock('@stores/useTableCollabStore', () => ({
  useCollabPeersForTable: () => [],
  useCollabIsOnlineForTable: () => false,
  useCollabStatusForTable: () => null,
  useCollabConnectionStatusForTable: () => null,
  useCollabReconnectForTable: () => null,
  useCollabViewUpdaterForTable: () => null,
}))

vi.mock('@tabtin/collab-core', () => ({
  CollabStatusBadge: () => null,
  CollabStatus: {},
}))

vi.mock('@components/table/TableReadonlyContext', () => ({
  useTableReadonly: () => ({ isTableReadonly: false }),
}))

vi.mock('@tabtin/table-ui', () => ({
  buildColumnMetaVisibilityUpdate: vi.fn(),
}))

vi.mock('@components/collab/OnlinePresencePopover', () => ({
  OnlinePresencePopover: () => null,
}))

import { TablePaneHeader } from './TablePaneHeader'

const table = {
  id: 'table-1',
  name: '项目表',
  description: null,
} as Table

describe('TablePaneHeader', () => {
  it('本期不展示个人视图开关', () => {
    render(<TablePaneHeader table={table} />)

    expect(screen.queryByText('个人视图')).toBeNull()
  })
})
