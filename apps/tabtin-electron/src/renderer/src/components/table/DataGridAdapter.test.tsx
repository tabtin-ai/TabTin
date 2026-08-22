import React from 'react'
import { describe, expect, it, vi } from 'vitest'

const { pasteConfirmState } = vi.hoisted(() => ({
  pasteConfirmState: {
    open: true,
    rowCount: 80,
    cellCount: 12,
    newRowCount: 4,
    skippedRows: 5,
    truncatedRows: 2,
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ConfirmDialog: ({ open, title, description }: Record<string, unknown>) =>
    open
      ? React.createElement(
          'div',
          null,
          React.createElement('div', null, title),
          React.createElement('div', null, description),
        )
      : null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      switch (key) {
        case 'table:clipboard.pasteConfirmTitle':
          return '粘贴确认'
        case 'table:clipboard.pasteConfirmWithNewRows':
          return `此操作将更新 ${options?.rows} 行中的 ${options?.cells} 个现有单元格，并自动创建 ${options?.newRows} 条新记录，是否继续？`
        case 'table:clipboard.pasteConfirmDescription':
          return `影响 ${options?.rows} 行、${options?.cells} 个单元格。`
        case 'table:clipboard.pasteConfirmTruncated':
          return `${options?.count} 行超出自动建行上限，将被跳过。`
        case 'table:clipboard.pasteConfirmSkipped':
          return `${options?.count} 行没有可写入值，将被跳过。`
        case 'common:cancel':
          return '取消'
        case 'table:clipboard.pasteConfirmButton':
          return '粘贴'
        case 'table:grid.editorShiftEnterHint':
          return 'hint'
        case 'table:grid.prefillingRowTitle':
          return 'prefill'
        case 'table:actions.cancelDraft':
          return 'cancel'
        default:
          return key
      }
    },
    i18n: {
      language: 'zh-CN',
      t: (key: string, options?: Record<string, unknown>) => {
        if (key === 'table:clipboard.pasteConfirmWithNewRows') {
          return `此操作将更新 ${options?.rows} 行中的 ${options?.cells} 个现有单元格，并自动创建 ${options?.newRows} 条新记录，是否继续？`
        }
        if (key === 'table:clipboard.pasteConfirmTruncated') {
          return `${options?.count} 行超出自动建行上限，将被跳过。`
        }
        if (key === 'table:clipboard.pasteConfirmSkipped') {
          return `${options?.count} 行没有可写入值，将被跳过。`
        }
        return key
      },
    },
  }),
}))

vi.mock('@tabtin/table-engine', () => ({
  resolveTableGridEngine: () => ({
    id: 'canvas',
    component: () => React.createElement('div', { 'data-testid': 'grid-engine' }),
  }),
}))

vi.mock('@tabtin/table-engine-canvas', () => ({
  CANVAS_TABLE_ENGINE: { id: 'canvas' },
  useGridOverlayStore: (selector: (state: any) => unknown) =>
    selector({ openHeaderMenu: vi.fn() }),
}))

vi.mock('@tabtin/table-ui', () => ({
  DataGridFullWidthRowRenderer: () => null,
  isDataGridFullWidthRow: () => false,
  postSortRowsKeepSpecialRowsAtBottom: (rows: unknown[]) => rows,
  buildRowsWithDraft: ({ groupedRows }: { groupedRows: unknown[] }) => groupedRows,
}))

vi.mock('./controller/useDataGridAdapterStores', () => ({
  useDataGridAdapterStores: () => ({
    selectedTable: { id: 'table-1', current_user_role: 'owner', space_id: null },
    fields: [],
    loadFields: vi.fn(),
    records: [],
    page: 1,
    pageSize: 50,
    total: 0,
    isRecordLoading: false,
    setRecordSorting: vi.fn(),
    updateRecord: vi.fn(),
    loadRecordsByTable: vi.fn(),
    createRecord: vi.fn(),
    mergeIncrementalRecords: vi.fn(),
    removeRecordsByIds: vi.fn(),
    latestVersion: 0,
    recordsEtag: null,
    resolvedTheme: 'light',
    selectedRows: [],
    setSelectedRows: vi.fn(),
    registerRecordEditor: vi.fn(),
    setTotalRowsCount: vi.fn(),
    views: [],
    currentViewId: 'view-1',
    updateView: vi.fn(),
    currentViewRecords: { records: [] },
    isRecordsLoading: false,
    recordsQuery: { page: 1, page_size: 50 },
    currentViewLatestVersion: 0,
    currentViewEtag: null,
    initializeDraft: vi.fn(),
    setDraftFilters: vi.fn(),
    setDraftGroups: vi.fn(),
    applyDraft: vi.fn(),
    toggleGroupCollapse: vi.fn(),
    toggleTreeRecordExpanded: vi.fn(),
    clearGroupCollapse: vi.fn(),
    refreshCurrentView: vi.fn(),
    setViewPage: vi.fn(),
    setViewPageSize: vi.fn(),
    draftFilters: [],
    collapsedGroupIds: [],
    treeExpandedRecords: undefined,
    viewStoreApi: {
      getState: () => ({
        currentViewRecords: { records: [] },
      }),
    },
  }),
}))

vi.mock('./controller/useDataGridDataset', () => ({
  useDataGridDataset: () => ({
    rowsData: [],
    searchableRows: [],
    groupPathByRecordId: new Map(),
    groupedRows: [],
    currentPage: 1,
    currentPageSize: 50,
    totalCount: 80,
  }),
}))

vi.mock('./controller/useDataGridColumns', () => ({
  useDataGridColumns: () => ({
    columns: [],
    orderedFields: [],
    firstEditableField: 'Name',
  }),
}))

vi.mock('./controller/useDataGridEditingController', () => ({
  useDataGridEditingController: () => ({
    draftRowData: null,
    draftAddRowContext: null,
    isDraftSubmitting: false,
    handleAddRowClick: vi.fn(),
    handleCellValueChanged: vi.fn(),
    handleCellEditingStopped: vi.fn(),
    handleCommitDraftRow: vi.fn(),
    handleCancelDraftRow: vi.fn(),
    handleDraftShortcutKeyDown: vi.fn(),
  }),
}))

vi.mock('./controller/useTableEngineObservability', () => ({
  useTableEngineObservability: () => ({
    snapshot: { current: null },
    trackMutationLatency: async (_op: string, task: () => Promise<unknown>) => task(),
    reportRendererError: vi.fn(),
  }),
}))

vi.mock('./controller/useDataGridViewRuntime', () => ({
  useDataGridViewRuntime: () => ({
    currentView: { id: 'view-1', config: {} },
    useViewData: true,
    startPolling: vi.fn(),
    checkIfTriggersAutoField: vi.fn(() => []),
  }),
}))

vi.mock('./controller/useDataGridCollabBridge', () => ({
  useDataGridCollabBridge: () => ({
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    isConnected: true,
    cancelPendingCreates: vi.fn(() => []),
    markCreatesPersisted: vi.fn(),
    getCreateLifecycle: vi.fn(),
    partitionDeleteTargets: vi.fn((ids: string[]) => ({
      pendingCancelIds: [],
      authoritativeDeleteIds: ids,
    })),
    collab: {
      isOnline: false,
      isFallback: true,
      status: 'fallback',
      peers: [],
      collabCanUndo: false,
      collabCanRedo: false,
      collabUndo: vi.fn(),
      collabRedo: vi.fn(),
      broadcastCellFocus: vi.fn(),
    },
  }),
}))

vi.mock('@stores/useTableCollabStore', () => ({
  useCollabPeerCursorsForTable: () => [],
}))

vi.mock('./hooks/useDataGridCollabSyncUI', () => ({
  useDataGridCollabSyncUI: () => ({
    disconnectPhase: 'none',
    disconnectSeconds: 0,
    handleForceReconnect: vi.fn(),
    handleCollabCellFocus: vi.fn(),
  }),
}))

vi.mock('./hooks/useDataGridPermission', () => ({
  useDataGridPermission: () => ({
    is403Error: () => false,
    mark403Readonly: vi.fn(),
  }),
}))

vi.mock('./hooks/useDataGridRecordOps', () => ({
  useDataGridRecordOps: () => ({
    isDataRecordRow: () => true,
    normalizeGroupValue: (value: unknown) => String(value),
    isGroupValuesMatch: () => false,
    resolveAnchorRow: () => null,
    resolveGroupValuesFromAnchor: () => undefined,
    buildDraftPrefillValues: () => undefined,
    resolveGroupAnchorRecordId: () => undefined,
    buildCreateRecordOrderContext: () => ({ position: 'end' }),
    buildCreatePlanFromDisplayRowIndex: () => ({ orderContext: { position: 'end' } }),
    handleDeleteRecords: vi.fn(),
    deleteConfirmState: null,
    confirmDeleteRecords: vi.fn(),
    cancelDeleteRecords: vi.fn(),
    handleDuplicateRecord: vi.fn(),
    handleInsertRecord: vi.fn(),
    handleCopyRecordUrl: vi.fn(),
    handleInsertSubRecord: vi.fn(),
  }),
}))

vi.mock('./hooks/useDataGridClipboard', () => ({
  useDataGridClipboard: () => ({
    handleClipboardCopy: vi.fn(),
    handleClipboardPaste: vi.fn(),
    pasteConfirmState,
    confirmPaste: vi.fn(),
    cancelPaste: vi.fn(),
  }),
}))

vi.mock('./hooks/useDataGridFocusHighlight', () => ({
  useDataGridFocusHighlight: () => ({
    focusRecordRow: vi.fn(),
    focusRecordRowWithRetry: vi.fn(),
    resolveFieldIdFromHistoryKey: vi.fn(),
    resolveColumnFieldFromHistoryKey: vi.fn(),
    highlightCellsImpl: vi.fn(),
    handleRecordCreatedVisible: vi.fn(),
    handleRecordCreatedVisibleForEditing: vi.fn(),
    handleRevealHiddenRecord: vi.fn(),
  }),
}))

vi.mock('./hooks/useDataGridFieldOps', () => ({
  useDataGridFieldOps: () => ({
    handleDeleteField: vi.fn(),
    handleHideField: vi.fn(),
    handleDuplicateFieldFromMenu: vi.fn(),
    handleFilterFieldFromMenu: vi.fn(),
    handleGroupFieldFromMenu: vi.fn(),
  }),
}))

vi.mock('./hooks/useDataGridSearch', () => ({
  useDataGridSearch: () => ({
    canvasSearchCursor: null,
    canvasSearchTargets: [],
    canvasSearchHitIndex: [],
    normalizedSearchQuery: '',
    matchedSearchRowIds: new Set<string>(),
    searchFilteredRowsForDisplay: [],
    searchMetricRowsForDisplay: [],
  }),
}))

vi.mock('./hooks/useDataGridLinkEditor', () => ({
  useDataGridLinkEditor: () => ({
    linkEditorState: null,
    handleCloseLinkEditor: vi.fn(),
    handleSaveLinkEditor: vi.fn(),
  }),
}))

vi.mock('./hooks/useDataGridStatistics', () => ({
  useDataGridStatistics: () => ({
    canvasStatisticSummaryLabel: 'summary',
  }),
}))

vi.mock('./hooks/useDataGridContextMenus', () => ({
  useDataGridContextMenus: () => ({
    handleSortFromMenu: vi.fn(),
    canvasFieldMenuLabels: {},
    canvasRecordMenuLabels: {},
    canvasStatisticMenuLabels: {},
    canvasEditorLabels: {},
    allRecordsCheckboxTooltip: 'Select or clear all records',
    notifyLockedViewDenied: vi.fn(),
  }),
}))

vi.mock('./hooks/useCanvasRowReorder', () => ({
  useCanvasRowReorder: () => ({
    handleCanvasRowReorder: vi.fn(),
  }),
}))

vi.mock('./controller/useColumnReorderPersistence', () => ({
  useColumnReorderPersistence: () => ({
    handleColumnMoved: vi.fn(),
  }),
}))
vi.mock('./controller/useViewFilterSync', () => ({
  useViewFilterSync: () => ({
    handleFilterChanged: vi.fn(),
  }),
}))
vi.mock('./controller/useDataGridGridEvents', () => ({
  useDataGridGridEvents: () => ({
    onGridReady: vi.fn(),
    onSelectionChanged: vi.fn(),
    onSortChanged: vi.fn(),
  }),
}))
vi.mock('./controller/useDataGridFieldContextMenu', () => ({
  useDataGridFieldContextMenu: () => ({
    handleFieldContextMenu: vi.fn(),
  }),
}))
vi.mock('./controller/useUndoRedo', () => ({
  useUndoRedo: () => ({
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    handleOpenRecordHistory: vi.fn(),
  }),
}))
vi.mock('./controller/useDataGridFallbackLoader', () => ({
  useDataGridFallbackLoader: () => undefined,
}))
vi.mock('./controller/useDataGridRecordEditor', () => ({
  useDataGridRecordEditor: () => ({
    recordEditor: null,
  }),
}))
vi.mock('@tabtin/table-engine/sync', () => ({
  useIncrementalViewMerge: () => ({
    merge: vi.fn(),
    remove: vi.fn(),
  }),
}))
vi.mock('./controller/useDataGridPresentationModel', () => ({
  useDataGridPresentationModel: () => ({
    rows: [],
    groupedRows: [],
    rowsData: [],
    firstColumnLeft: 0,
  }),
}))

vi.mock('./DataGridOverlayLayer', () => ({
  DataGridOverlayLayer: () => null,
}))

vi.mock('@stores/useTableViewUiStore', () => ({
  useTableViewUiStore: (selector: (state: any) => unknown) =>
    selector({
      personalViewByScope: {},
      personalViewDraftByScope: {},
      setPersonalViewDraft: vi.fn(),
    }),
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: (selector: (state: any) => unknown) =>
    selector({
      tableFontSize: 14,
      resolvedTheme: 'light',
    }),
}))

vi.mock('@stores/useViewStore', () => ({
  useViewStore: (selector: (state: any) => unknown) =>
    selector({
      loadViews: vi.fn(),
    }),
}))

vi.mock('./DataGridContext', () => ({
  useDataGridContext: () => ({
    searchQuery: '',
    searchScope: 'all_fields',
    searchSelectedFieldIds: [],
    searchHideNotMatchRows: false,
    searchNavigateRequest: 0,
    reportSearchState: vi.fn(),
    openRecordEditor: vi.fn(),
    serverSearchHits: [],
    serverSearchLoading: false,
    serverSearchTotalCount: 0,
    useServerSearch: false,
    serverSearchHasMore: false,
    serverSearchLoadNextPage: vi.fn(),
    registerHighlightCells: vi.fn(),
    isTableReadonly: false,
    setTableReadonly: vi.fn(),
    selectedRows: [],
    setSelectedRows: vi.fn(),
    registerRecordEditor: vi.fn(),
    setTotalRowsCount: vi.fn(),
  }),
}))

vi.mock('./utils/gridDisplayUtils', () => ({
  resolveFreezeColumnCountFromViewConfig: () => 0,
  resolveGridDisplayRowId: (row: any) => row?.id ?? null,
  isCanvasDraggableDataRow: () => false,
  buildCanvasRowsSignature: () => 'sig',
}))

describe('DataGridAdapter', () => {
  it('deep-link focus waits for the initial collaboration projection', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )

    expect(content).toContain('isRecordFocusCollabBootstrapPending({')
    expect(content).toContain('recordFocusCollabTimeoutCandidateKey')
    expect(content).toContain('recordFocusCollabBootstrapGeneration')
    expect(content).toContain('}, 2_000)')
    expect(content).toContain('isRecordFocusCollabDataLoading')
  })
  it('搜索隐藏行时统计与行计数应使用匹配行口径', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )

    expect(content).toContain('searchMetricRowsForDisplay,')
    expect(content).toMatch(
      /useDataGridStatistics\(\{[\s\S]*searchFilteredRowsForDisplay: searchMetricRowsForDisplay,/,
    )
    expect(content).toMatch(
      /useRowCounterDisplay\(\{[\s\S]*searchFilteredRowsForDisplay: searchMetricRowsForDisplay,/,
    )
  })

  it('Canvas 追加行应把展示位置交给视图感知的创建计划', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )

    expect(content).toMatch(/handleCanvasRowAppend[\s\S]*rowIndex\?: number/)
    expect(content).toMatch(
      /startDraftRow[\s\S]*buildCreatePlanFromDisplayRowIndex\(displayRowIndex\)/,
    )
    expect(content).toMatch(
      /handleCanvasRowAppend[\s\S]*startDraftRow\([^)]*context\?\.rowIndex/,
    )
    expect(content).toContain("log.debug('视图投影或折叠分组保留行内草稿'")
    expect(content).toMatch(/isCollapsedGroupAppend[\s\S]*__groupCollapsed/)
    expect(content).toMatch(
      /handleAddRowClick\(\{[\s\S]*order_context: createPlan\.orderContext/,
    )
  })

  it('应在粘贴确认弹窗中附带截断和跳过提示', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )

    expect(content).toContain("t('table:clipboard.pasteConfirmTruncated'")
    expect(content).toContain("t('table:clipboard.pasteConfirmSkipped'")
    expect(content).toContain('pasteConfirmState.skippedRows > pasteConfirmState.truncatedRows')
    expect(content).toContain('pasteConfirmState.skippedRows -')
    expect(content).toContain('pasteConfirmState.truncatedRows')
  })

  it('不再把分页控件接入 Electron 表格主网格', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )

    expect(content).not.toContain('DataGridPaginationBar')
    expect(content).not.toContain('usePaginationLogic')
    expect(content).not.toContain('onPaginationChanged')
    expect(content).not.toContain('handlePaginationChanged')
  })

  it('附件上传完成前不应预先把引用绑定到记录', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )

    expect(content).toMatch(
      /attachmentStore\.startUpload\(\{[\s\S]*recordId: undefined,[\s\S]*taskRecordId: identityRecordId,/,
    )
  })

  it('连接中状态不在网格内容区显示顶部横幅', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )

    expect(content).not.toContain("t('table:collab.connecting')")
    expect(content).toContain("import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';")
  })

  it('连接中状态仍显示在表头协作状态徽标', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'TablePaneHeader.tsx'),
      'utf-8',
    )

    expect(content).toContain('shouldShowTableCollabStatusBadge(')
    expect(content).toContain('showCollabStatusBadge && collabStatus != null && (')
    expect(content).not.toContain('collabStatus !== CollabStatus.CONNECTING')
  })

  it('表头协作状态徽标可见性应只隐藏初始和正常首次连接态', async () => {
    const { CollabConnectionStatus, CollabStatus } = await import('@tabtin/collab-core')
    const { shouldShowTableCollabStatusBadge } = await import('./tableCollabStatusBadgeVisibility')

    expect(shouldShowTableCollabStatusBadge(CollabStatus.INITIAL, null)).toBe(false)
    expect(
      shouldShowTableCollabStatusBadge(
        CollabStatus.CONNECTING,
        CollabConnectionStatus.CONNECTING,
      ),
    ).toBe(false)
    expect(shouldShowTableCollabStatusBadge(CollabStatus.CONNECTING, null)).toBe(true)
    expect(
      shouldShowTableCollabStatusBadge(
        CollabStatus.DISCONNECTED,
        CollabConnectionStatus.DISCONNECTED,
      ),
    ).toBe(true)
  })

  it('onUrlCellClick 应透传 tabScopeKey 给 openResourceUrlInSpace', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )

    expect(content).toContain('useContextTabScopeKey')
    expect(content).toContain('useOptionalSpaceContextState')
    expect(content).toContain('resolveBrowserOpenTabScopeKey')
    expect(content).toContain('buildTableKey')
    expect(content).toContain('openResourceUrlInSpace(href, tabScopeKey)')
    expect(content).toContain('onUrlCellClick: handleUrlCellClick')
    expect(content).not.toMatch(/onUrlCellClick:\s*openResourceUrlInSpace\b/)
  })

  it('表格与看板应共用包含历史身份快照的成员姓名映射', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const content = fs.readFileSync(
      path.resolve(__dirname, 'DataGridAdapter.tsx'),
      'utf-8',
    )
    const kanbanContent = fs.readFileSync(
      path.resolve(__dirname, '../view/KanbanView.tsx'),
      'utf-8',
    )
    const memberHookContent = fs.readFileSync(
      path.resolve(__dirname, 'hooks/useTableMemberDisplayNames.ts'),
      'utf-8',
    )

    expect(content).toContain('useTableMemberDisplayNames')
    expect(kanbanContent).toContain('useTableMemberDisplayNames')
    expect(memberHookContent).toContain('useMembersQuery')
    expect(memberHookContent).toContain('useMemberIdentitySnapshotsQuery')
    expect(memberHookContent).toContain('currentMembersResponse?.members ?? storedMembers')
    expect(memberHookContent).toContain('useUserProfileCache')
    expect(memberHookContent).toContain('buildRealtimeUserDisplayNameById')
    expect(memberHookContent).toContain('mergeUserDisplayNamesIntoMembers')
    expect(memberHookContent).toContain('memberIdentitySnapshots?.identities')
    expect(content).toMatch(/useDataGridDataset\(\{[\s\S]*?userDisplayNameById,[\s\S]*?\}\)/)
    expect(content).toMatch(/organizationMembers,[\s\S]*?userDisplayNameById,[\s\S]*?subRecordParentFieldId/)
    expect(kanbanContent).toMatch(/useKanbanViewController\(\{[\s\S]*?userDisplayNameById,[\s\S]*?\}\)/)
  })
})
