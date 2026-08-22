import { describe, expect, it } from 'vitest'
import type { TabDocRuntimeMonitorSnapshot } from '@components/context-space/tabdoc/tabdoc-runtime-monitor'
import type { TabDataRuntimeMonitorSnapshot } from '@components/table/table-runtime-monitor'
import type { ResourceMonitorSnapshot } from '@shared/types/resource-monitor'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { buildResourceMonitorViewModel } from './model'
import { deriveResourceMonitorHistoryState } from './history'

function createGroup(spaceId: string, tabKeys: string[]): CanvasLayoutGroup {
  return {
    id: `group-${spaceId}`,
    spaceId,
    anchorTabKey: tabKeys[0] as `${string}:${string}`,
    panes: tabKeys.map((tabKey, index) => ({
      id: `pane-${spaceId}-${index}`,
      content: { tabKey: tabKey as `${string}:${string}` },
    })),
    layout: {
      type: 'leaf',
      paneId: `pane-${spaceId}-0`,
    },
    activePaneId: `pane-${spaceId}-0`,
    createdAt: 1,
    updatedAt: 1,
  }
}

function createSnapshot(): ResourceMonitorSnapshot {
  return {
    host: {
      totalMemory: 16 * 1024 * 1024 * 1024,
      freeMemory: 10 * 1024 * 1024 * 1024,
      usedMemory: 6 * 1024 * 1024 * 1024,
      memoryUsagePercent: 37.5,
      cpuCoreCount: 8,
      loadAverage1m: 1.2,
    },
    app: {
      cpu: 48,
      memory: 900 * 1024 * 1024,
      main: { cpu: 8, memory: 200 * 1024 * 1024 },
      renderer: { cpu: 28, memory: 600 * 1024 * 1024 },
      other: { cpu: 12, memory: 100 * 1024 * 1024 },
    },
    ptySessions: [
      {
        sessionId: 'agent-1',
        spaceId: 'space-1',
        pid: 101,
        cwd: '/tmp/space-1',
        isRunning: true,
        createdAt: 1,
        lastOutputAt: 2,
        lastExitCode: null,
        lastCommandCompletedAt: null,
        hasPendingCommand: true,
        cpu: 16,
        memory: 200 * 1024 * 1024,
      },
      {
        sessionId: 'shell-2',
        spaceId: null,
        pid: 102,
        cwd: '/tmp/space-2',
        isRunning: true,
        createdAt: 1,
        lastOutputAt: 2,
        lastExitCode: null,
        lastCommandCompletedAt: 3,
        hasPendingCommand: false,
        cpu: 6,
        memory: 100 * 1024 * 1024,
      },
    ],
    browserViews: [
      {
        viewId: 'view-1',
        crawlspaceId: 'cs-1',
        runId: 'run-1',
        profile: 'user-tab',
        title: 'Deep crawl',
        url: 'https://example.com/article',
        webContentsId: 11,
        osPid: 201,
        sharedProcessCount: 1,
        inUse: true,
        attachedToMainWindow: true,
        isLoading: false,
        isPreview: false,
        cpu: 12,
        memory: 300 * 1024 * 1024,
      },
      {
        viewId: 'view-2',
        crawlspaceId: 'cs-2',
        runId: 'run-2',
        profile: 'workspace-view',
        title: 'Pricing',
        url: 'https://www.example.com/pricing',
        webContentsId: 12,
        osPid: 202,
        sharedProcessCount: 1,
        inUse: false,
        attachedToMainWindow: true,
        isLoading: false,
        isPreview: false,
        cpu: 5,
        memory: 150 * 1024 * 1024,
      },
      {
        viewId: 'view-3',
        crawlspaceId: null,
        runId: null,
        profile: 'preview',
        title: '',
        url: 'https://background.example.com',
        webContentsId: 13,
        osPid: 203,
        sharedProcessCount: 2,
        inUse: false,
        attachedToMainWindow: false,
        isLoading: true,
        isPreview: true,
        cpu: 2,
        memory: 50 * 1024 * 1024,
      },
    ],
    runSummary: {
      totalRuns: 3,
      activeRuns: 2,
      totalViews: 3,
      inUseViews: 1,
    },
    runs: [
      {
        runId: 'run-1',
        sessionId: 'sess-1',
        spaceId: 'space-1',
        crawlspaceId: 'cs-1',
        viewCount: 1,
        inUseViewCount: 1,
        activeViewId: 'view-1',
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 3,
        eventCount: 5,
      },
      {
        runId: 'run-2',
        sessionId: 'sess-2',
        spaceId: null,
        crawlspaceId: 'cs-2',
        viewCount: 1,
        inUseViewCount: 0,
        activeViewId: 'view-2',
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 3,
        eventCount: 4,
      },
      {
        runId: 'run-3',
        sessionId: 'sess-3',
        spaceId: null,
        crawlspaceId: null,
        viewCount: 1,
        inUseViewCount: 0,
        activeViewId: 'view-3',
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 3,
        eventCount: 2,
      },
    ],
    viewFactory: {
      total: 6,
      inUse: 3,
      idle: 3,
      byProfile: {
        'user-tab': 2,
      },
      pending: {
        resource: 1,
        cdp: 0,
      },
    },
    totalCpu: 72,
    totalMemory: 1200 * 1024 * 1024,
    collectedAt: 123456,
  }
}



function createTabDocRuntimeSnapshot(): TabDocRuntimeMonitorSnapshot {
  return {
    owner: {
      instanceId: 'doc-host-1',
      documentId: 'doc-1',
      title: '产品策略',
      spaceId: 'space-1',
      organizationId: null,
      tabKey: 'tabdoc:doc-1',
      isPaneActive: true,
      isVisible: true,
      isLoading: false,
      hasError: false,
    },
    ownerStrategy: 'active-pane',
    metrics: {
      saveState: 'saving',
      saveMessage: 'saving',
      latestVersion: 12,
      revisionCount: 12,
      historyCount: 4,
      markdownLength: 1800,
      plaintextLength: 1320,
      wordCount: 220,
      isCollaborating: true,
      activeEditorCount: 2,
      peerCount: 2,
      isAgentEditing: true,
      eventStreamStatus: 'synced',
      isFallback: false,
      hasYdoc: true,
      updatedAt: 1001,
    },
    mountedHostCount: 1,
    visibleHostCount: 1,
    activePaneHostCount: 1,
    updatedAt: 1001,
  }
}

function createTabDataRuntimeSnapshot(): TabDataRuntimeMonitorSnapshot {
  return {
    owner: {
      instanceId: 'table-host-1',
      tableId: 'table-1',
      title: '销售漏斗',
      spaceId: 'space-1',
      organizationId: null,
      tabKey: 'tabdata:table-1',
      isPaneActive: true,
      isVisible: true,
      isLoading: false,
      hasError: false,
    },
    ownerStrategy: 'active-pane',
    metrics: {
      tableName: '销售漏斗',
      tableRowCount: 1200,
      viewRowCount: 320,
      loadedRowCount: 100,
      renderedRowCount: 104,
      fieldCount: 18,
      visibleFieldCount: 12,
      hiddenFieldCount: 6,
      currentViewId: 'view-1',
      currentViewName: '高优先客户',
      filterCount: 2,
      sortCount: 1,
      groupCount: 1,
      hasGrouping: true,
      hasSubRecordTree: false,
      isPersonalViewEnabled: true,
      currentPage: 2,
      currentPageSize: 100,
      gridLoading: false,
      isRecordsLoading: false,
      isRecordLoading: false,
      selectedRowCount: 3,
      useViewData: true,
      collabStatus: 'connected',
      isCollabOnline: true,
      peerCount: 2,
      isCollabFallback: false,
      engineId: 'canvas',
      engineScopeId: 'table-1',
      scrollFpsP95: 52,
      scrollFpsAverage: 48,
      inputLatencyP95: 180,
      inputLatencyAverage: 132,
      scrollFpsSampleCount: 8,
      inputLatencySampleCount: 4,
      hasInteractionSamples: true,
      errorRatePct: 5,
      totalOperations: 4,
      operationErrors: 0,
      runtimeErrors: 0,
      updatedAt: 1002,
    },
    mountedHostCount: 2,
    visibleHostCount: 1,
    activePaneHostCount: 1,
    updatedAt: 1002,
  }
}

function createHistoryState(snapshot: ResourceMonitorSnapshot = createSnapshot()) {
  return deriveResourceMonitorHistoryState([
    {
      collectedAt: snapshot.collectedAt - 120000,
      totalCpu: 54,
      totalMemory: 980 * 1024 * 1024,
      ramSharePercent: 6,
      hostUsedMemoryPercent: 32,
      browserCpu: 8,
      browserMemory: 320 * 1024 * 1024,
      browserViewCount: 2,
      detachedBrowserViewCount: 0,
      previewBrowserViewCount: 0,
      loadingBrowserViewCount: 0,
      ptySessionCount: 1,
      activeRuns: 1,
    },
    {
      collectedAt: snapshot.collectedAt,
      totalCpu: snapshot.totalCpu,
      totalMemory: snapshot.totalMemory,
      ramSharePercent: 7.5,
      hostUsedMemoryPercent: snapshot.host.memoryUsagePercent,
      browserCpu: snapshot.browserViews.reduce((sum, view) => sum + view.cpu, 0),
      browserMemory: snapshot.browserViews.reduce((sum, view) => sum + view.memory, 0),
      browserViewCount: snapshot.browserViews.length,
      detachedBrowserViewCount: snapshot.browserViews.filter((view) => !view.attachedToMainWindow).length,
      previewBrowserViewCount: snapshot.browserViews.filter((view) => view.isPreview).length,
      loadingBrowserViewCount: snapshot.browserViews.filter((view) => view.isLoading).length,
      ptySessionCount: snapshot.ptySessions.length,
      activeRuns: snapshot.runSummary.activeRuns,
    },
  ], {
    now: snapshot.collectedAt + 1000,
  })
}

describe('buildResourceMonitorViewModel', () => {
  it('按 Space 聚合 Browser / Terminal，并保留后台与宿主开销', () => {
    const model = buildResourceMonitorViewModel({
      snapshot: createSnapshot(),
      history: createHistoryState(),
      dataRuntime: null,

      docRuntime: null,
      activeSpaceId: 'space-1',
      spaces: [
        { id: 'space-1', name: '创作台', organization_id: 'ws-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
        { id: 'space-2', name: '增长实验', organization_id: 'ws-1', status: 'active', table_count: 0, order: 2, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {
        'cs-1': {
          crawlspaceId: 'cs-1',
          spaceId: 'space-1',
          profile: 'workspace-view',
          partition: 'persist:space-1',
        },
        'cs-2': {
          crawlspaceId: 'cs-2',
          spaceId: 'space-2',
          profile: 'workspace-view',
          partition: 'persist:space-2',
        },
      },
      crawlspaceContextCache: {
        'cs-1': {
          activeViewId: 'view-1',
          viewList: [
            {
              viewId: 'view-1',
              title: 'Deep crawl',
              url: 'https://example.com/article',
              createdAt: 1,
            },
          ],
        },
      },
      tabOrderBySpace: {
        'space-1': ['tabweb:view-1', 'terminal:agent-1', 'tabdata:table-1'],
        'space-2': ['tabweb:view-2', 'terminal:shell-2'],
      },
      activeKeyBySpace: {
        'space-1': 'tabweb:view-1',
        'space-2': 'terminal:shell-2',
      },
      spaceGroupsBySpace: {
        'space-1': [createGroup('space-1', ['tabweb:view-1', 'tabdata:table-1'])],
        'space-2': [createGroup('space-2', ['tabweb:view-2'])],
      },
      terminalSessionsBySpace: {
        'space-1': [
          {
            id: 'agent-1',
            spaceId: 'space-1',
            title: 'Research Agent',
            createdAt: 1,
            source: 'agent',
            status: 'active',
          },
        ],
        'space-2': [
          {
            id: 'shell-2',
            spaceId: 'space-2',
            title: 'Organization Shell',
            createdAt: 1,
            source: 'user',
            status: 'active',
          },
        ],
      },
    })

    expect(model.overview.totalRuns).toBe(3)
    expect(model.overview.activeRuns).toBe(2)
    expect(model.overview.severity.level).toBe('healthy')
    expect(model.history.sampleCount).toBe(2)
    expect(model.currentSpace?.spaceName).toBe('创作台')
    expect(model.currentSpace?.totalMemory).toBe(500 * 1024 * 1024)
    expect(model.currentSpace?.browserCount).toBe(1)
    expect(model.currentSpace?.agentCount).toBe(1)
    expect(model.currentSpace?.tabCount).toBe(3)
    expect(model.currentSpace?.paneCount).toBe(2)
    expect(model.currentSpace?.appBreakdown.map((entry) => entry.label)).toEqual(['Browser', '终端', 'TabData'])

    expect(model.spaces.map((space) => [space.spaceId, space.totalMemory])).toEqual([
      ['space-1', 500 * 1024 * 1024],
      ['space-2', 250 * 1024 * 1024],
    ])

    expect(model.background.unassignedMemory).toBe(50 * 1024 * 1024)
    expect(model.background.overheadMemory).toBe(400 * 1024 * 1024)
    expect(model.background.rendererResidualMemory).toBe(100 * 1024 * 1024)
    expect(model.background.hostOverheadMemory).toBe(300 * 1024 * 1024)
    expect(model.background.totalMemory).toBe(450 * 1024 * 1024)
    expect(model.background.explanations.some((note) => note.title === '黑盒拆分')).toBe(true)
    expect(model.browser.totalCount).toBe(3)
    expect(model.browser.totalMemory).toBe(500 * 1024 * 1024)
    expect(model.browser.currentSpaceCount).toBe(1)
    expect(model.browser.detachedCount).toBe(1)
    expect(model.browser.sharedProcessViewCount).toBe(1)
    expect(model.browser.closableCount).toBe(0)
    expect(model.browser.distributionBuckets.map((bucket) => [bucket.id, bucket.count, bucket.memory])).toEqual([
      ['main-window', 2, 450 * 1024 * 1024],
      ['detached', 0, 0],
      ['preview', 1, 50 * 1024 * 1024],
    ])
    expect(model.browser.overlayBuckets.map((bucket) => [bucket.id, bucket.count, bucket.memory])).toEqual([
      ['shared-process', 1, 50 * 1024 * 1024],
      ['unassigned', 1, 50 * 1024 * 1024],
    ])
    expect(model.browser.governanceNote).toContain('不会关闭主窗口里的普通标签')
    expect(model.browser.explanations[0]?.title).toBe('治理边界')
    expect(model.browser.explanations[0]?.description).toContain('本轮不会自动关闭')
    expect(model.browser.explanations.some((note) => note.title === '主要来源')).toBe(true)
    expect(model.browser.explanations.some((note) => note.title === '黑盒去向')).toBe(true)
    expect(model.browser.memoryTrend.direction).toBe('up')
    expect(model.browser.cpuTrend.direction).toBe('up')
    expect(model.browser.historySummary.viewCountDelta).toBe(1)
    expect(model.browser.explanations.some((note) => note.title.includes('近'))).toBe(true)
    expect(model.browser.severity.level).toBe('attention')
    expect(model.browser.topItems.map((item) => item.id)).toEqual(['view-1', 'view-2', 'view-3'])
    expect(model.suggestions.map((suggestion) => suggestion.id)).toEqual([
      'background-overhead',
      'browser-runtime',
      'close-all-tabs',
    ])
    expect(model.suggestions[0]?.target.kind).toBe('none')
    expect(model.suggestions[0]?.description).toContain('共享 renderer 残余')
    expect(model.suggestions[1]?.id).toBe('browser-runtime')
    expect(model.suggestions[1]?.actionLabel).toBe('一键回收空闲 Browser')
    expect(model.suggestions[1]?.actionDisabled).toBe(true)
    expect(model.suggestions[1]?.target.kind).toBe('none')
    expect(model.suggestions[1]?.note).toContain('不会关闭主窗口里的普通标签')
  })

  it('优先使用 store 元数据补全终端归属与标题，并标记激活项', () => {
    const model = buildResourceMonitorViewModel({
      snapshot: createSnapshot(),
      history: createHistoryState(),
      dataRuntime: null,

      docRuntime: null,
      activeSpaceId: 'space-2',
      spaces: [
        { id: 'space-2', name: '增长实验', organization_id: 'ws-1', status: 'active', table_count: 0, order: 2, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {
        'cs-2': {
          crawlspaceId: 'cs-2',
          spaceId: 'space-2',
          profile: 'workspace-view',
          partition: 'persist:space-2',
        },
      },
      crawlspaceContextCache: {},
      tabOrderBySpace: {
        'space-2': ['terminal:shell-2'],
      },
      activeKeyBySpace: {
        'space-2': 'terminal:shell-2',
      },
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {
        'space-2': [
          {
            id: 'shell-2',
            spaceId: 'space-2',
            title: 'Organization Shell',
            createdAt: 1,
            source: 'user',
            status: 'active',
            cwd: '/Users/developer/dev/TabTin',
          },
        ],
      },
    })

    const targetSpace = model.spaces.find((space) => space.spaceId === 'space-2')
    const shellItem = targetSpace?.items.find((item) => item.id === 'shell-2')

    expect(targetSpace?.runCount).toBe(1)
    expect(shellItem?.title).toBe('Organization Shell')
    expect(shellItem?.spaceId).toBe('space-2')
    expect(shellItem?.active).toBe(true)
    expect(shellItem?.badgeLabel).toBe('Terminal')
  })

  it('把 TabDoc 运行态作为解释性明细挂到对应 Space，且不改变总账口径', () => {
    const model = buildResourceMonitorViewModel({
      snapshot: createSnapshot(),
      history: createHistoryState(),
      dataRuntime: null,

      docRuntime: createTabDocRuntimeSnapshot(),
      activeSpaceId: 'space-1',
      spaces: [
        { id: 'space-1', name: '创作台', organization_id: 'ws-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {},
      crawlspaceContextCache: {},
      tabOrderBySpace: {
        'space-1': ['tabdoc:doc-1'],
      },
      activeKeyBySpace: {
        'space-1': 'tabdoc:doc-1',
      },
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {},
    })

    expect(model.currentSpace?.totalMemory).toBe(500 * 1024 * 1024)
    expect(model.overview.totalMemory).toBe(1200 * 1024 * 1024)
    expect(model.docRuntime?.spaceId).toBe('space-1')
    expect(model.docRuntime?.title).toBe('产品策略')
    expect(model.docRuntime?.saveState).toBe('saving')
    expect(model.docRuntime?.severity.level).toBe('attention')
    expect(model.docRuntime?.wordCount).toBe(220)
    expect(model.docRuntime?.isCollaborating).toBe(true)
    expect(model.docRuntime?.isAgentEditing).toBe(true)
    expect(model.docRuntime?.hasYdoc).toBe(true)
  })

  it('把 TabData 运行态作为解释性明细挂到对应 Space，且不改变总账口径', () => {
    const model = buildResourceMonitorViewModel({
      snapshot: createSnapshot(),
      history: createHistoryState(),
      dataRuntime: createTabDataRuntimeSnapshot(),

      docRuntime: null,
      activeSpaceId: 'space-1',
      spaces: [
        { id: 'space-1', name: '创作台', organization_id: 'ws-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {},
      crawlspaceContextCache: {},
      tabOrderBySpace: {
        'space-1': ['tabdata:table-1'],
      },
      activeKeyBySpace: {
        'space-1': 'tabdata:table-1',
      },
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {},
    })

    expect(model.currentSpace?.totalMemory).toBe(500 * 1024 * 1024)
    expect(model.overview.totalMemory).toBe(1200 * 1024 * 1024)
    expect(model.dataRuntime?.spaceId).toBe('space-1')
    expect(model.dataRuntime?.title).toBe('销售漏斗')
    expect(model.dataRuntime?.viewRowCount).toBe(320)
    expect(model.dataRuntime?.visibleFieldCount).toBe(12)
    expect(model.dataRuntime?.currentViewName).toBe('高优先客户')
    expect(model.dataRuntime?.scrollFpsP95).toBe(52)
    expect(model.dataRuntime?.severity.level).toBe('attention')
    expect(model.dataRuntime?.hasInteractionSamples).toBe(true)
  })

  it('后台自动轮询时不显示会迅速消失的旧快照刷新建议', () => {
    const snapshot = createSnapshot()
    snapshot.browserViews = []
    snapshot.ptySessions = []
    snapshot.runs = []
    snapshot.runSummary = {
      totalRuns: 0,
      activeRuns: 0,
      totalViews: 0,
      inUseViews: 0,
    }
    snapshot.app = {
      cpu: 0,
      memory: 0,
      main: { cpu: 0, memory: 0 },
      renderer: { cpu: 0, memory: 0 },
      other: { cpu: 0, memory: 0 },
    }
    snapshot.totalCpu = 0
    snapshot.totalMemory = 0

    const model = buildResourceMonitorViewModel({
      snapshot,
      history: deriveResourceMonitorHistoryState([
        {
          collectedAt: snapshot.collectedAt,
          totalCpu: snapshot.totalCpu,
          totalMemory: snapshot.totalMemory,
          ramSharePercent: 0,
          hostUsedMemoryPercent: snapshot.host.memoryUsagePercent,
          browserCpu: 0,
          browserMemory: 0,
          browserViewCount: 0,
          detachedBrowserViewCount: 0,
          previewBrowserViewCount: 0,
          loadingBrowserViewCount: 0,
          ptySessionCount: 0,
          activeRuns: 0,
        },
      ], {
        now: snapshot.collectedAt + 60000,
      }),
      dataRuntime: null,

      docRuntime: null,
      activeSpaceId: null,
      spaces: [],
      crawlspaceConfigById: {},
      crawlspaceContextCache: {},
      tabOrderBySpace: {},
      activeKeyBySpace: {},
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {},
    })

    expect(model.history.stale).toBe(true)
    expect(model.suggestions.some((suggestion) => suggestion.id === 'refresh-stale-snapshot')).toBe(false)
  })

  it('仅把脱屏空闲 Browser 识别为可安全回收，并在达到 2 个时生成批量治理建议', () => {
    const snapshot = createSnapshot()
    snapshot.browserViews.push(
      {
        viewId: 'view-4',
        crawlspaceId: 'cs-2',
        runId: 'run-2',
        profile: 'workspace-view',
        title: 'Background docs',
        url: 'https://example.com/docs',
        webContentsId: 14,
        osPid: 204,
        sharedProcessCount: 1,
        inUse: false,
        attachedToMainWindow: false,
        isLoading: false,
        isPreview: false,
        cpu: 3,
        memory: 180 * 1024 * 1024,
      },
      {
        viewId: 'view-5',
        crawlspaceId: 'cs-2',
        runId: 'run-2',
        profile: 'preview',
        title: 'Detached preview',
        url: 'https://example.com/preview',
        webContentsId: 15,
        osPid: 205,
        sharedProcessCount: 1,
        inUse: false,
        attachedToMainWindow: false,
        isLoading: false,
        isPreview: true,
        cpu: 2,
        memory: 120 * 1024 * 1024,
      },
    )
    snapshot.totalCpu += 5
    snapshot.totalMemory += 300 * 1024 * 1024

    const model = buildResourceMonitorViewModel({
      snapshot,
      history: createHistoryState(snapshot),
      dataRuntime: null,

      docRuntime: null,
      activeSpaceId: 'space-1',
      activeTabScopeKey: 'scope-current',
      spaces: [
        { id: 'space-1', name: '创作台', organization_id: 'ws-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
        { id: 'space-2', name: '增长实验', organization_id: 'ws-1', status: 'active', table_count: 0, order: 2, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {
        'cs-1': {
          crawlspaceId: 'cs-1',
          spaceId: 'space-1',
          profile: 'workspace-view',
          partition: 'persist:space-1',
        },
        'cs-2': {
          crawlspaceId: 'cs-2',
          spaceId: 'space-2',
          profile: 'workspace-view',
          partition: 'persist:space-2',
        },
      },
      crawlspaceContextCache: {
        'cs-2': {
          activeViewId: 'view-4',
          viewList: [
            {
              viewId: 'view-4',
              title: 'Background docs',
              url: 'https://example.com/docs',
              createdAt: 1,
            },
          ],
        },
      },
      tabOrderBySpace: {
        'space-1': ['tabweb:view-1'],
        'space-2': ['tabweb:view-2', 'tabweb:view-4', 'tabweb:view-5'],
      },
      activeKeyBySpace: {
        'scope-current': 'tabweb:view-1',
        'space-1': 'tabweb:view-1',
      },
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {},
    })

    expect(model.browser.closableCount).toBe(2)
    expect(model.browser.closableDetachedCount).toBe(2)
    expect(model.browser.closablePreviewCount).toBe(1)
    expect(model.browser.closableItems.map((item) => item.id)).toEqual(['view-4', 'view-5'])
    expect(model.browser.distributionBuckets.map((bucket) => [bucket.id, bucket.count, bucket.memory])).toEqual([
      ['main-window', 2, 450 * 1024 * 1024],
      ['detached', 1, 180 * 1024 * 1024],
      ['preview', 2, 170 * 1024 * 1024],
    ])
    expect(model.browser.explanations[0]?.description).toContain('可安全回收 2 个 Browser')
    expect(model.browser.explanations.some((note) => note.title === '主要来源')).toBe(true)
    expect(model.browser.explanations.some((note) => note.title.includes('近'))).toBe(true)
    const browserSuggestion = model.suggestions.find((suggestion) => suggestion.id === 'browser-runtime')
    expect(browserSuggestion?.actionLabel).toBe('一键回收空闲 Browser')
    expect(browserSuggestion?.actionDisabled).toBe(false)
    expect(browserSuggestion?.target.kind).toBe('close-items')
    expect(browserSuggestion?.note).toContain('不会关闭主窗口里的普通标签')
    if (browserSuggestion?.target.kind === 'close-items') {
      expect(browserSuggestion.target.items.map((item) => item.id)).toEqual(['view-4', 'view-5'])
    }
  })

  it('spaceId 直传优先于 crawlspaceId 反查归因', () => {
    const snapshot = createSnapshot()
    snapshot.browserViews = [
      {
        viewId: 'view-direct',
        crawlspaceId: null,
        runId: null,
        spaceId: 'space-1',
        profile: 'agent-workspace',
        title: '直接归因视图',
        url: 'https://example.com',
        webContentsId: 20,
        osPid: 300,
        sharedProcessCount: 1,
        inUse: true,
        attachedToMainWindow: true,
        isLoading: false,
        isPreview: false,
        cpu: 5,
        memory: 100 * 1024 * 1024,
      },
      {
        viewId: 'view-override',
        crawlspaceId: 'cs-2',
        runId: null,
        spaceId: 'space-1',
        profile: 'agent-workspace',
        title: '覆盖归因视图',
        url: 'https://example.com/override',
        webContentsId: 21,
        osPid: 301,
        sharedProcessCount: 1,
        inUse: false,
        attachedToMainWindow: true,
        isLoading: false,
        isPreview: false,
        cpu: 3,
        memory: 80 * 1024 * 1024,
      },
    ]
    snapshot.ptySessions = []
    snapshot.runs = []
    snapshot.runSummary = { totalRuns: 0, activeRuns: 0, totalViews: 0, inUseViews: 0 }

    const model = buildResourceMonitorViewModel({
      snapshot,
      history: createHistoryState(),
      dataRuntime: null,

      docRuntime: null,
      activeSpaceId: 'space-1',
      spaces: [
        { id: 'space-1', name: '创作台', organization_id: 'ws-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
        { id: 'space-2', name: '增长实验', organization_id: 'ws-1', status: 'active', table_count: 0, order: 2, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {
        'cs-2': {
          crawlspaceId: 'cs-2',
          spaceId: 'space-2',
          profile: 'workspace-view',
          partition: 'persist:space-2',
        },
      },
      crawlspaceContextCache: {},
      tabOrderBySpace: {},
      activeKeyBySpace: {},
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {},
    })

    const space1 = model.spaces.find((s) => s.spaceId === 'space-1')
    expect(space1).toBeDefined()
    const browserItems = space1!.items.filter((item) => item.kind === 'browser')
    expect(browserItems.map((item) => item.id).sort()).toEqual(['view-direct', 'view-override'])

    const space2 = model.spaces.find((s) => s.spaceId === 'space-2')
    expect(space2).toBeUndefined()
  })

  it('总标签数不应把会话 scope 中保留的历史标签重复算作已打开标签', () => {
    const historicalScopeTabs = Object.fromEntries(
      Array.from({ length: 47 }, (_, index) => [
        `conversation:session-${index}`,
        [`tabdoc:historical-${index}`],
      ]),
    )

    const model = buildResourceMonitorViewModel({
      snapshot: createSnapshot(),
      history: createHistoryState(),
      dataRuntime: null,
      docRuntime: null,
      activeSpaceId: 'space-1',
      activeTabScopeKey: 'desktop:current',
      spaces: [
        { id: 'space-1', name: '创作台', organization_id: 'ws-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {},
      crawlspaceContextCache: {},
      tabOrderBySpace: {
        'desktop:current': ['tabweb:view-1'],
        ...historicalScopeTabs,
      },
      activeKeyBySpace: {},
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {},
    })

    expect(model.overview.totalTabCount).toBe(1)
    expect(model.overview.currentTabCount).toBe(1)
    expect(model.suggestions.find((item) => item.id === 'close-all-tabs')?.target).toEqual({
      kind: 'close-tabs',
      scopes: [{
        spaceId: 'space-1',
        scopeKey: 'desktop:current',
        tabKeys: ['tabweb:view-1'],
      }],
    })
  })

  it('当前工作台有多个标签时提供保留当前标签的一键清理动作', () => {
    const model = buildResourceMonitorViewModel({
      snapshot: createSnapshot(),
      history: createHistoryState(),
      dataRuntime: null,
      docRuntime: null,
      activeSpaceId: 'space-1',
      activeTabScopeKey: 'conversation:current',
      sessionScopes: [
        { sessionId: 'current', spaceId: 'space-1' },
        { sessionId: 'other', spaceId: 'space-1' },
      ],
      spaces: [
        { id: 'space-1', name: '创作台', organization_id: 'ws-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {},
      crawlspaceContextCache: {},
      tabOrderBySpace: {
        'conversation:current': ['tabdoc:current', 'tabdata:visible'],
        'conversation:other': ['tabdata:old-1', 'tabweb:old-2'],
        'conversation:archived': ['tabdoc:archived'],
      },
      activeKeyBySpace: {
        'conversation:current': 'tabdoc:current',
      },
      spaceGroupsBySpace: {
        'conversation:current': [createGroup('conversation:current', ['tabdoc:current', 'tabdata:visible'])],
      },
      terminalSessionsBySpace: {},
    })

    const suggestion = model.suggestions.find((item) => item.id === 'close-all-tabs')
    expect(suggestion?.actionLabel).toBe('关闭全部标签')
    expect(suggestion?.target).toEqual({
      kind: 'close-tabs',
      scopes: [
        {
          spaceId: 'space-1',
          scopeKey: 'conversation:current',
          tabKeys: ['tabdoc:current', 'tabdata:visible'],
        },
        {
          spaceId: 'space-1',
          scopeKey: 'conversation:other',
          tabKeys: ['tabdata:old-1', 'tabweb:old-2'],
        },
      ],
    })
  })

  it('允许回收已结束会话遗留的脱屏 Agent Browser，但继续保护执行中的会话', () => {
    const buildModel = (busySessionIds: ReadonlySet<string>) => {
      const snapshot = createSnapshot()
      snapshot.browserViews = [{
        viewId: 'view-orphan',
        crawlspaceId: 'cs-orphan',
        runId: null,
        spaceId: 'space-1',
        profile: 'agent-workspace',
        title: '123 - Google 搜索',
        url: 'https://www.google.com/search?q=123',
        webContentsId: 24,
        osPid: 304,
        sharedProcessCount: 1,
        inUse: true,
        attachedToMainWindow: false,
        isLoading: false,
        isPreview: false,
        cpu: 1,
        memory: 210 * 1024 * 1024,
      }]
      snapshot.ptySessions = []
      snapshot.runs = []
      snapshot.runSummary = { totalRuns: 0, activeRuns: 0, totalViews: 1, inUseViews: 1 }

      return buildResourceMonitorViewModel({
        snapshot,
        history: createHistoryState(snapshot),
        dataRuntime: null,
        docRuntime: null,
        activeSpaceId: 'space-1',
        activeTabScopeKey: 'conversation:session-orphan',
        busySessionIds,
        spaces: [
          { id: 'space-1', name: '创作台', organization_id: 'ws-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
        ],
        crawlspaceConfigById: {
          'cs-orphan': {
            crawlspaceId: 'cs-orphan',
            browserScopeKey: 'conversation:session-orphan',
            spaceId: 'space-1',
            profile: 'agent-workspace',
            partition: 'persist:agent-workspace',
          },
        },
        crawlspaceContextCache: {
          'cs-orphan': {
            activeViewId: 'view-orphan',
            viewList: [{
              viewId: 'view-orphan',
              title: '123 - Google 搜索',
              url: 'https://www.google.com/search?q=123',
              createdAt: 1,
            }],
          },
        },
        tabOrderBySpace: {
          'conversation:session-orphan': ['tabdoc:doc-current', 'tabweb:view-orphan'],
        },
        activeKeyBySpace: {
          'conversation:session-orphan': 'tabdoc:doc-current',
        },
        spaceGroupsBySpace: {},
        terminalSessionsBySpace: {},
      })
    }

    const idleModel = buildModel(new Set())
    expect(idleModel.browser.closableItems.map((item) => item.id)).toEqual(['view-orphan'])
    expect(idleModel.browser.closableItems[0]?.status).toBe('idle')

    const busyModel = buildModel(new Set(['session-orphan']))
    expect(busyModel.browser.closableCount).toBe(0)
    expect(busyModel.browser.topItems[0]?.status).toBe('active')
  })

  it('同时统计当前会话和真实会话列表中的全部已打开标签', () => {
    const model = buildResourceMonitorViewModel({
      snapshot: createSnapshot(),
      history: createHistoryState(),
      dataRuntime: null,
      docRuntime: null,
      activeSpaceId: 'space-1',
      activeTabScopeKey: 'conversation:current',
      sessionScopes: [
        { sessionId: 'current', spaceId: 'space-1' },
        { sessionId: 'other', spaceId: 'space-1' },
      ],
      spaces: [
        { id: 'space-1', name: 'Current space', organization_id: 'org-1', status: 'active', table_count: 0, order: 1, is_archived: false, is_default: false, created_at: '', updated_at: '' },
      ],
      crawlspaceConfigById: {},
      crawlspaceContextCache: {},
      tabOrderBySpace: {
        'conversation:current': ['tabdoc:current'],
        'conversation:other': ['tabdata:other-1', 'tabweb:other-2'],
        'conversation:deleted': ['tabdoc:stale'],
      },
      activeKeyBySpace: { 'conversation:current': 'tabdoc:current' },
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {},
    })

    expect(model.overview.currentTabCount).toBe(1)
    expect(model.overview.totalTabCount).toBe(3)
  })

  it('当前会话已归档时不将其标签并入总数和批量关闭目标', () => {
    const model = buildResourceMonitorViewModel({
      snapshot: createSnapshot(),
      history: createHistoryState(),
      dataRuntime: null,
      docRuntime: null,
      activeSpaceId: 'space-1',
      activeTabScopeKey: 'conversation:archived',
      excludeActiveTabScope: true,
      sessionScopes: [],
      spaces: [],
      crawlspaceConfigById: {},
      crawlspaceContextCache: {},
      tabOrderBySpace: {
        'conversation:archived': ['tabdoc:archived'],
      },
      activeKeyBySpace: {},
      spaceGroupsBySpace: {},
      terminalSessionsBySpace: {},
    })

    expect(model.overview.currentTabCount).toBe(1)
    expect(model.overview.totalTabCount).toBe(0)
    expect(model.suggestions.find((item) => item.id === 'close-all-tabs')).toBeUndefined()
  })

})
