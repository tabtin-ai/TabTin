import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const openSettings = vi.fn()

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({ openSettings }),
  },
}))

vi.mock('./useResourceMonitorController', () => ({
  useResourceMonitorController: vi.fn(() => ({
    surfaceSeverityLevel: 'healthy',
    viewModel: {
      overview: {
        severity: { level: 'healthy', label: '松弛', reason: '资源占用正常' },
        collectedAt: Date.now(),
        totalCpu: 0,
        cpuCoreCount: 8,
        totalMemory: 1_000_000_000,
        ramSharePercent: 2,
        currentTabCount: 1,
        totalTabCount: 1,
        totalPaneCount: 0,
      },
      history: { stale: false, memoryTrend: {}, cpuTrend: {} },
      suggestions: [],
      spaces: [],
      currentSpace: null,
      topItems: [],
      background: {
        rendererResidualMemory: 0,
        rendererResidualCpu: 0,
        hostOverheadMemory: 0,
        hostOverheadCpu: 0,
        unassignedMemory: 0,
        unassignedCpu: 0,
      },
      browser: {
        closableCount: 0,
        closableItems: [],
        totalCount: 0,
        totalMemorySharePercent: 0,
      },
    },
    isLoading: false,
    isRefreshing: false,
    error: null,
    rankedSpaces: [],
    spaceNameById: new Map(),
    recentGovernanceEvents: [],
    onRefresh: vi.fn(),
    onNavigateToSpace: vi.fn(),
    onNavigateToItem: vi.fn(),
    onNavigateToDataRuntime: vi.fn(),
    onNavigateToDocRuntime: vi.fn(),
    onCloseGovernanceItems: vi.fn(),
    onSuggestionAction: vi.fn(),
  })),
}))

import { useResourceMonitorController } from './useResourceMonitorController'
import { ResourceMonitorSidebarIndicator } from './ResourceMonitorSidebarIndicator'

const mockUseResourceMonitorController = vi.mocked(useResourceMonitorController)

describe('ResourceMonitorSidebarIndicator', () => {
  it('顶栏入口展示与 severity 对应的指示灯', () => {
    render(<ResourceMonitorSidebarIndicator placement="topbar" />)

    const dot = screen.getByTestId('resource-monitor-severity-dot')
    expect(dot.className).toContain('bg-success')
  })

  it('资源压力升高时指示灯变为 warning / destructive', () => {
    mockUseResourceMonitorController.mockReturnValueOnce({
      ...(mockUseResourceMonitorController() as ReturnType<typeof useResourceMonitorController>),
      surfaceSeverityLevel: 'heavy',
      viewModel: {
        ...(mockUseResourceMonitorController().viewModel),
        overview: {
          ...(mockUseResourceMonitorController().viewModel.overview),
          severity: { level: 'heavy', label: '吃紧', reason: '应用内存进入高压区间' },
        },
      },
    } as ReturnType<typeof useResourceMonitorController>)

    render(<ResourceMonitorSidebarIndicator placement="topbar" />)
    expect(screen.getByTestId('resource-monitor-severity-dot').className).toContain('bg-destructive')
  })

  it('点击「查看详情」打开设置页性能监控', () => {
    openSettings.mockClear()
    render(<ResourceMonitorSidebarIndicator placement="topbar" />)

    fireEvent.click(screen.getByTestId('shell-top-bar-performance-monitor'))
    fireEvent.click(screen.getByTestId('resource-monitor-view-details'))

    expect(openSettings).toHaveBeenCalledWith({ category: 'device', section: 'performance' })
  })
})
