/**
 * ResourceMonitorPanelContent — 「检查 Browser 视图堆积」常驻卡 + 一键回收
 */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { ResourceMonitorSnapshot } from '@shared/types/resource-monitor'
import { ResourceMonitorPanelContent } from '../ResourceMonitorPanel'
import { buildResourceMonitorViewModel } from '../model'
import { deriveResourceMonitorHistoryState } from '../history'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'resourceMonitor.spaceSection': 'Space',
        'resourceMonitor.browser': 'Browser',
        'resourceMonitor.browserReclaim.checkTitle': 'Check Browser view buildup',
        'resourceMonitor.browserReclaim.action': 'Reclaim idle Browsers',
        'resourceMonitor.browserReclaim.actionUnavailable': 'No reclaimable items',
        'resourceMonitor.browserReclaim.available': '{{count}} idle Browser(s) can be reclaimed',
        'resourceMonitor.browserReclaim.noneIdle': 'No idle Browser to reclaim right now',
        'resourceMonitor.browserReclaim.noBrowsers': 'No Browser views tracked',
        'resourceMonitor.browserReclaim.reclaimMany': '{{reason}}. Reclaim {{count}} detached idle Browsers first.',
        'resourceMonitor.browserReclaim.reclaimOne': '{{reason}}. Close detached idle Browser {{title}} first.',
        'resourceMonitor.browserReclaim.overview': '{{reason}}. There are currently {{total}} Browser views, {{share}} of the total.',
        'resourceMonitor.browserReclaim.retained': '{{count}} detached Browser view(s) are still in use or loading. They will not be reclaimed to avoid interrupting work.',
        'resourceMonitor.currentTabs': 'Current tabs',
        'resourceMonitor.allSessionTabs': '{{count}} total tabs',
        'resourceMonitor.closeAllTabs': 'Close all tabs in every non-archived session',
      }
      let str = map[key] ?? key
      if (options) {
        for (const [k, v] of Object.entries(options)) {
          str = str.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v))
        }
      }
      return str
    },
    i18n: { language: 'zh-CN' },
  }),
}))

function createEmptyGroups(): Record<string, CanvasLayoutGroup[]> {
  return {}
}

function buildViewModel(browserViews: ResourceMonitorSnapshot['browserViews']) {
  const snapshot: ResourceMonitorSnapshot = {
    host: {
      totalMemory: 16 * 1024 * 1024 * 1024,
      freeMemory: 10 * 1024 * 1024 * 1024,
      usedMemory: 6 * 1024 * 1024 * 1024,
      memoryUsagePercent: 37.5,
      cpuCoreCount: 8,
      loadAverage1m: 1.2,
    },
    app: {
      cpu: 10,
      memory: 100 * 1024 * 1024,
      main: { cpu: 2, memory: 20 * 1024 * 1024 },
      renderer: { cpu: 6, memory: 60 * 1024 * 1024 },
      other: { cpu: 2, memory: 20 * 1024 * 1024 },
    },
    rendererWindows: [],
    ptySessions: [],
    browserViews,
    runSummary: { totalRuns: 0, activeRuns: 0, totalViews: browserViews.length, inUseViews: 0 },
    runs: [],
    viewFactory: { total: 0, inUse: 0, idle: 0, byProfile: {}, pending: { resource: 0, cdp: 0 } },
    totalCpu: 10,
    totalMemory: 100 * 1024 * 1024,
    collectedAt: Date.now(),
  }

  return buildResourceMonitorViewModel({
    snapshot,
    history: deriveResourceMonitorHistoryState([]),
    dataRuntime: null,
    docRuntime: null,
    activeSpaceId: 'space-1',
    spaces: [],
    crawlspaceConfigById: {},
    crawlspaceContextCache: {},
    tabOrderBySpace: {},
    activeKeyBySpace: {},
    spaceGroupsBySpace: createEmptyGroups(),
    terminalSessionsBySpace: {},
  })
}

function renderPanel(browserViews: ResourceMonitorSnapshot['browserViews']) {
  const viewModel = buildViewModel(browserViews)
  const onCloseGovernanceItems = vi.fn()
  const onSuggestionAction = vi.fn()
  render(
    <ResourceMonitorPanelContent
      variant="embedded"
      viewModel={viewModel}
      isLoading={false}
      isRefreshing={false}
      error={null}
      governanceEvents={[]}
      rankedSpaces={viewModel.spaces}
      spaceNameById={new Map()}
      onRefresh={() => {}}
      onNavigateToSpace={() => {}}
      onNavigateToItem={() => {}}
      onNavigateToDataRuntime={() => {}}
      onNavigateToDocRuntime={() => {}}
      onCloseGovernanceItems={onCloseGovernanceItems}
      onSuggestionAction={onSuggestionAction}
    />,
  )
  return { viewModel, onCloseGovernanceItems, onSuggestionAction }
}

describe('ResourceMonitorPanelContent · Browser 检查卡', () => {
  it('满载时直接显示触发满载的具体原因', () => {
    const viewModel = buildViewModel([])
    viewModel.overview.severity = {
      level: 'heavy',
      label: '满载',
      reason: '应用内存已达 4.0 GB，总账资源进入高压区间',
    }

    render(
      <ResourceMonitorPanelContent
        variant="embedded"
        viewModel={viewModel}
        isLoading={false}
        isRefreshing={false}
        error={null}
        governanceEvents={[]}
        rankedSpaces={viewModel.spaces}
        spaceNameById={new Map()}
        onRefresh={() => {}}
        onNavigateToSpace={() => {}}
        onNavigateToItem={() => {}}
        onNavigateToDataRuntime={() => {}}
        onNavigateToDocRuntime={() => {}}
        onCloseGovernanceItems={() => {}}
        onSuggestionAction={() => {}}
      />,
    )

    expect(screen.getByText('应用内存已达 4.0 GB，总账资源进入高压区间')).toBeTruthy()
  })

  it('有其他标签时在标签指标下提供一键关闭入口', () => {
    const viewModel = buildViewModel([])
    const suggestion = {
      id: 'close-all-tabs',
      severity: viewModel.overview.severity,
      title: '关闭当前未显示的标签',
      description: '保留当前标签和分屏中正在显示的标签，关闭其余 2 个标签。',
      note: null,
      actionLabel: 'Close all tabs in every non-archived session',
      target: {
        kind: 'close-tabs' as const,
        scopes: [{
          spaceId: 'space-1',
          scopeKey: 'conversation:session-1',
          tabKeys: ['tabdoc:old-1', 'tabdata:old-2'],
        }],
      },
    }
    viewModel.suggestions.push(suggestion)
    const onSuggestionAction = vi.fn()

    render(
      <ResourceMonitorPanelContent
        variant="embedded"
        viewModel={viewModel}
        isLoading={false}
        isRefreshing={false}
        error={null}
        governanceEvents={[]}
        rankedSpaces={viewModel.spaces}
        spaceNameById={new Map()}
        onRefresh={() => {}}
        onNavigateToSpace={() => {}}
        onNavigateToItem={() => {}}
        onNavigateToDataRuntime={() => {}}
        onNavigateToDocRuntime={() => {}}
        onCloseGovernanceItems={() => {}}
        onSuggestionAction={onSuggestionAction}
      />,
    )

    fireEvent.click(screen.getByTestId('resource-monitor-tabs-cleanup'))
    expect(onSuggestionAction).toHaveBeenCalledWith(suggestion)
  })

  it('无可回收空闲时仍显示检查卡，回收按钮置灰', () => {
    const { viewModel, onSuggestionAction } = renderPanel([])

    const browserSuggestion = viewModel.suggestions.find((s) => s.id === 'browser-runtime')
    expect(browserSuggestion).toBeTruthy()
    expect(browserSuggestion?.severity.level).toBe('healthy')
    expect(browserSuggestion?.actionDisabled).toBe(true)
    expect(screen.getByText('Check Browser view buildup')).toBeTruthy()
    expect(screen.getByText(/No Browser views tracked/)).toBeTruthy()

    const button = screen.getByRole('button', { name: /No reclaimable items/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onSuggestionAction).not.toHaveBeenCalled()
  })

  it('脱屏 Browser 仍在使用时不标红，并解释为何不可回收', () => {
    const browserViews: ResourceMonitorSnapshot['browserViews'] = Array.from({ length: 3 }, (_, index) => ({
      viewId: `view-in-use-${index}`,
      crawlspaceId: `cs-history-${index}`,
      runId: `run-${index}`,
      spaceId: 'space-1',
      profile: 'agent-workspace',
      title: `仍在使用的 Browser ${index + 1}`,
      url: `https://example.com/in-use/${index}`,
      webContentsId: 10 + index,
      osPid: 100 + index,
      sharedProcessCount: 1,
      inUse: true,
      attachedToMainWindow: false,
      isLoading: false,
      isPreview: false,
      cpu: 0,
      memory: 0,
    }))

    const { viewModel, onSuggestionAction } = renderPanel(browserViews)
    const browserSuggestion = viewModel.suggestions.find((s) => s.id === 'browser-runtime')

    expect(viewModel.browser.detachedCount).toBe(3)
    expect(viewModel.browser.closableCount).toBe(0)
    expect(browserSuggestion?.severity.level).toBe('healthy')
    expect(screen.getByText(/3 detached Browser view\(s\) are still in use or loading/)).toBeTruthy()

    const button = screen.getByRole('button', { name: /No reclaimable items/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onSuggestionAction).not.toHaveBeenCalled()
  })

  it('有可回收空闲时按钮可点并触发 suggestion', () => {
    const { viewModel, onSuggestionAction } = renderPanel([
      {
        viewId: 'view-idle-detached',
        crawlspaceId: 'cs-2',
        runId: null,
        profile: 'workspace-view',
        title: '脱屏空闲标签',
        url: 'https://example.com/idle',
        webContentsId: 2,
        osPid: 101,
        sharedProcessCount: 1,
        inUse: false,
        attachedToMainWindow: false,
        isLoading: false,
        isPreview: false,
        cpu: 1,
        memory: 50 * 1024 * 1024,
      },
    ])

    const browserSuggestion = viewModel.suggestions.find((s) => s.id === 'browser-runtime')
    expect(browserSuggestion?.actionDisabled).toBe(false)

    const button = screen.getByRole('button', { name: /Reclaim idle Browsers/ }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onSuggestionAction).toHaveBeenCalledTimes(1)
    expect(onSuggestionAction.mock.calls[0]![0]).toEqual(browserSuggestion)
  })

  it('shows the total tab count with a close-all icon and hover explanation', async () => {
    const viewModel = buildViewModel([])
    Object.assign(viewModel.overview, {
      currentTabCount: 1,
      totalTabCount: 6,
    })
    viewModel.suggestions.push({
      id: 'close-all-tabs',
      severity: viewModel.overview.severity,
      title: 'Close all tabs',
      description: 'Close every tab in this context.',
      note: null,
      actionLabel: 'Close all tabs',
      target: {
        kind: 'close-tabs',
        scopes: [{
          spaceId: 'space-1',
          scopeKey: 'conversation:session-1',
          tabKeys: ['tabdoc:current'],
        }],
      },
    })

    render(
      <ResourceMonitorPanelContent
        variant="embedded"
        viewModel={viewModel}
        isLoading={false}
        isRefreshing={false}
        error={null}
        governanceEvents={[]}
        rankedSpaces={viewModel.spaces}
        spaceNameById={new Map()}
        onRefresh={() => {}}
        onNavigateToSpace={() => {}}
        onNavigateToItem={() => {}}
        onNavigateToDataRuntime={() => {}}
        onNavigateToDocRuntime={() => {}}
        onCloseGovernanceItems={() => {}}
        onSuggestionAction={() => {}}
      />,
    )

    expect(screen.getByText('Current tabs')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
    const totalTabs = screen.getByText('6 total tabs')
    const closeButton = screen.getByRole('button', { name: 'Close all tabs in every non-archived session' })
    expect(closeButton).toBeTruthy()
    expect(totalTabs.parentElement?.contains(closeButton)).toBe(true)
    fireEvent.focus(closeButton)
    expect((await screen.findAllByText('Close all tabs in every non-archived session')).length).toBeGreaterThan(0)
  })
})
