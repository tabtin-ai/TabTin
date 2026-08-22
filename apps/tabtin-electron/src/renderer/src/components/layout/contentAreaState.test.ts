import { describe, expect, it } from 'vitest'
import {
  mergePortalTableIds,
  resolveContentAreaUiState,
  resolveEffectivePortalTableIds,
} from './contentAreaState'

describe('resolveContentAreaUiState', () => {
  it('space 工作台上的 tabweb 应展示 workspace layer，并保持 portal 可用', () => {
    const state = resolveContentAreaUiState({
      workbenchMode: 'space',
      hasActiveSpaceContext: true,
      activeContextType: 'tabweb',
    })

    expect(state.portalEnabled).toBe(true)
    expect(state.isWorkspaceTabActive).toBe(true)
    expect(state.workspaceLayerVisible).toBe(true)
  })

  it('space 工作台上的非 tabweb 页面不应展示 workspace layer', () => {
    const state = resolveContentAreaUiState({
      workbenchMode: 'space',
      hasActiveSpaceContext: true,
      activeContextType: 'table',
    })

    expect(state.portalEnabled).toBe(true)
    expect(state.isWorkspaceTabActive).toBe(false)
    expect(state.workspaceLayerVisible).toBe(false)
  })

  it('shell 画布隐藏时，即使 tabweb 激活也不应展示 workspace layer', () => {
    const state = resolveContentAreaUiState({
      workbenchMode: 'space',
      hasActiveSpaceContext: true,
      activeContextType: 'tabweb',
      shellCanvasVisible: false,
    })

    expect(state.portalEnabled).toBe(true)
    expect(state.isWorkspaceTabActive).toBe(true)
    expect(state.workspaceLayerVisible).toBe(false)
  })

  it('im-chat 会话桌面（有默认 Workspace）复用 portal 容器承载画布', () => {
    const state = resolveContentAreaUiState({
      workbenchMode: 'im-chat',
      hasActiveSpaceContext: true,
      activeContextType: 'tabweb',
    })

    expect(state.portalEnabled).toBe(true)
    expect(state.isWorkspaceTabActive).toBe(true)
    expect(state.workspaceLayerVisible).toBe(true)
  })

  it('im-chat 兜底态（无默认 Workspace）不挂 portal，退回全屏聊天', () => {
    const state = resolveContentAreaUiState({
      workbenchMode: 'im-chat',
      hasActiveSpaceContext: false,
      activeContextType: null,
    })

    expect(state.portalEnabled).toBe(false)
    expect(state.workspaceLayerVisible).toBe(false)
  })

  it('cloud-docs 一级域有 Space 时应挂 portal（PersistentTableTabs 依赖 TablePanePortalProvider）', () => {
    const state = resolveContentAreaUiState({
      workbenchMode: 'cloud-docs',
      hasActiveSpaceContext: true,
      activeContextType: 'tabdata',
    })

    expect(state.portalEnabled).toBe(true)
    expect(state.isWorkspaceTabActive).toBe(false)
    expect(state.workspaceLayerVisible).toBe(false)
  })

  it('cloud-docs 无 Space 上下文时不挂 portal', () => {
    const state = resolveContentAreaUiState({
      workbenchMode: 'cloud-docs',
      hasActiveSpaceContext: false,
      activeContextType: null,
    })

    expect(state.portalEnabled).toBe(false)
    expect(state.workspaceLayerVisible).toBe(false)
  })

  it('placeholder / welcome 态不应意外挂载 portal 容器', () => {
    const placeholderState = resolveContentAreaUiState({
      workbenchMode: 'placeholder',
      hasActiveSpaceContext: false,
      activeContextType: 'tabweb',
    })
    const welcomeState = resolveContentAreaUiState({
      workbenchMode: 'welcome',
      hasActiveSpaceContext: false,
      activeContextType: null,
    })

    expect(placeholderState.portalEnabled).toBe(false)
    expect(placeholderState.workspaceLayerVisible).toBe(false)
    expect(welcomeState.portalEnabled).toBe(false)
    expect(welcomeState.workspaceLayerVisible).toBe(false)
  })
})

describe('resolveEffectivePortalTableIds', () => {
  it('cloud-docs 仅保留当前激活表，避免历史 tabdata 全量进 portal', () => {
    expect(resolveEffectivePortalTableIds({
      workbenchMode: 'cloud-docs',
      portalTableIds: ['t1', 't2', 't3'],
      activeTableId: 't2',
    })).toEqual(['t1', 't2', 't3'])
    expect(resolveEffectivePortalTableIds({
      workbenchMode: 'cloud-docs',
      portalTableIds: ['t1', 't2'],
      activeTableId: null,
    })).toEqual(['t1', 't2'])
  })

  it('cloud-docs limits the initial portal window and includes the active table', () => {
    expect(resolveEffectivePortalTableIds({
      workbenchMode: 'cloud-docs',
      portalTableIds: ['t1', 't2', 't3', 't4', 't5', 't6'],
      activeTableId: null,
    })).toEqual(['t2', 't3', 't4', 't5', 't6'])
    expect(resolveEffectivePortalTableIds({
      workbenchMode: 'cloud-docs',
      portalTableIds: ['t1', 't2', 't3', 't4', 't5', 't6'],
      activeTableId: 't1',
    })).toEqual(['t1', 't3', 't4', 't5', 't6'])
  })

  it('非 cloud-docs 工作台保持全量 portalTableIds', () => {
    expect(resolveEffectivePortalTableIds({
      workbenchMode: 'space',
      portalTableIds: ['t1', 't2'],
      activeTableId: 't1',
    })).toEqual(['t1', 't2'])
  })
})

describe('mergePortalTableIds', () => {
  it('应合并打开标签、分屏标签和当前激活表格，并保持去重后的稳定顺序', () => {
    const merged = mergePortalTableIds({
      activeSpaceId: 'space-1',
      openTableTabs: ['t1', 't2', 't1'],
      groupedTableIds: new Set(['t3', 't2']),
      activeContextTableId: 't4',
    })

    expect(merged).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('没有 activeSpaceId 时不应输出遗留 portal 表格', () => {
    const merged = mergePortalTableIds({
      activeSpaceId: null,
      openTableTabs: ['t1'],
      groupedTableIds: new Set(['t2']),
      activeContextTableId: 't3',
    })

    expect(merged).toEqual([])
  })
})
