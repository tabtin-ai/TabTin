import { describe, expect, it } from 'vitest'
import {
  buildTabDataRuntimeMetrics,
  deriveTabDataRuntimeMonitorSnapshot,
} from './table-runtime-monitor'

describe('table-runtime-monitor', () => {
  it('优先把运行态归属到最近活跃的表格 pane，并保留每表独立性能采样', () => {
    const activeMetrics = buildTabDataRuntimeMetrics({
      tableName: 'Revenue',
      tableRowCount: 1200,
      viewRowCount: 320,
      loadedRowCount: 120,
      renderedRowCount: 126,
      fieldCount: 18,
      visibleFieldCount: 12,
      currentViewId: 'view-1',
      currentViewName: '高优先客户',
      filters: [
        { id: 'f-1', enabled: true },
        { id: 'f-2', enabled: false },
      ],
      sorts: [{ field_id: 'amount', direction: 'desc' }],
      groups: [{ field_id: 'stage' }],
      hasGrouping: true,
      hasSubRecordTree: false,
      isPersonalViewEnabled: true,
      currentPage: 2,
      currentPageSize: 100,
      gridLoading: false,
      isRecordsLoading: false,
      isRecordLoading: false,
      selectedRowCount: 4,
      useViewData: true,
      collabStatus: 'connected',
      isCollabOnline: true,
      peerCount: 2,
      isCollabFallback: false,
      engineSnapshot: {
        version: 1,
        currentBucketId: 'canvas::table-1',
        currentEngineId: 'canvas',
        currentScopeId: 'table-1',
        current: {
          bucketId: 'canvas::table-1',
          engineId: 'canvas',
          scopeId: 'table-1',
          updatedAt: 900,
          scrollFps: {
            count: 8,
            latest: 59,
            average: 56,
            p50: 57,
            p95: 58,
            min: 48,
            max: 60,
          },
          inputLatencyMs: {
            count: 5,
            latest: 120,
            average: 140,
            p50: 128,
            p95: 180,
            min: 88,
            max: 180,
          },
          errorRate: {
            totalOperations: 5,
            operationErrors: 1,
            runtimeErrors: 0,
            ratePct: 20,
          },
        },
        baseline: {},
      },
    })
    const hiddenMetrics = buildTabDataRuntimeMetrics({
      tableName: 'Backlog',
      tableRowCount: 800,
      viewRowCount: 800,
      loadedRowCount: 100,
      renderedRowCount: 101,
      fieldCount: 10,
      visibleFieldCount: 8,
      currentViewId: null,
      currentViewName: null,
      filters: [],
      sorts: [],
      groups: [],
      hasGrouping: false,
      hasSubRecordTree: true,
      isPersonalViewEnabled: false,
      currentPage: 1,
      currentPageSize: 100,
      gridLoading: false,
      isRecordsLoading: false,
      isRecordLoading: false,
      selectedRowCount: 0,
      useViewData: false,
      collabStatus: 'idle',
      isCollabOnline: false,
      peerCount: 0,
      isCollabFallback: true,
      engineSnapshot: null,
    })

    const snapshot = deriveTabDataRuntimeMonitorSnapshot(
      [
        {
          instanceId: 'host-active',
          meta: {
            tableId: 'table-1',
            title: '收入看板',
            spaceId: 'space-1',
            organizationId: null,
            tabKey: 'tabdata:table-1',
            isPaneActive: true,
            isVisible: true,
            isLoading: false,
            hasError: false,
          },
          registeredAt: 100,
          metaUpdatedAt: 300,
        },
        {
          instanceId: 'host-hidden',
          meta: {
            tableId: 'table-2',
            title: '待办库',
            spaceId: 'space-2',
            organizationId: null,
            tabKey: 'tabdata:table-2',
            isPaneActive: false,
            isVisible: false,
            isLoading: false,
            hasError: false,
          },
          registeredAt: 120,
          metaUpdatedAt: 320,
        },
      ],
      new Map([
        ['table-1', { key: 'table-1', metrics: activeMetrics, updatedAt: activeMetrics.updatedAt }],
        ['table-2', { key: 'table-2', metrics: hiddenMetrics, updatedAt: hiddenMetrics.updatedAt }],
      ]),
    )

    expect(snapshot?.owner?.instanceId).toBe('host-active')
    expect(snapshot?.ownerStrategy).toBe('active-pane')
    expect(snapshot?.metrics?.tableName).toBe('Revenue')
    expect(snapshot?.metrics?.filterCount).toBe(1)
    expect(snapshot?.metrics?.groupCount).toBe(1)
    expect(snapshot?.metrics?.scrollFpsP95).toBe(58)
    expect(snapshot?.metrics?.inputLatencyP95).toBe(180)
    expect(snapshot?.metrics?.hasInteractionSamples).toBe(true)
    expect(snapshot?.visibleHostCount).toBe(1)
  })
})
