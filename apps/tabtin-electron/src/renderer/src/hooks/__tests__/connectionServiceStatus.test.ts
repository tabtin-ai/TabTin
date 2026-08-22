import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { CollabConnectionStatus, CollabStatus } from '@tabtin/collab-core'
import {
  buildConnectionServiceLines,
  pickCollabIndicatorMessage,
} from '@/hooks/connectionServiceStatus'

const t = ((key: string, defaultValue?: string) => defaultValue ?? key) as TFunction<'common'>

const baseInput = {
  networkOnline: true,
  imStatus: 'connected' as const,
  imWasConnected: true,
  agentGatewayStatus: 'ready' as const,
  tableCollabStatuses: [] as Array<{
    status: CollabStatus | null
    connectionStatus?: string | null
    isOnline: boolean
    isFallback?: boolean
    syncModeReason?: string | null
  }>,
  tabDataCollabStatus: null as string | null,
  tabDataCollabOnline: null as boolean | null,
  tabDataCollabFallback: false,
  tabDataCollabSyncModeReason: null as string | null,
  tabDocCollaborating: false,
  tabDocCollabStatus: null as string | null,
  tabDocEventStreamStatus: null as string | null,
  tabDocCollabFallback: false,
}

describe('connectionServiceStatus', () => {
  it('无协作文档时不展示协作同步行', () => {
    const lines = buildConnectionServiceLines({ ...baseInput }, t)

    expect(lines.map((line) => line.id)).toEqual([
      'network',
      'messaging',
      'agentGateway',
    ])
    expect(lines.find((line) => line.id === 'collab')).toBeUndefined()
  })

  it('有协作文档时才展示协作同步行', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{ status: CollabStatus.DISCONNECTED, isOnline: false }],
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('destructive')
    expect(pickCollabIndicatorMessage(collabLine, t)?.message).toContain('协作文档')
  })

  it('字段可见性 REST 投影降级不标红', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{
        status: CollabStatus.INITIAL,
        isOnline: false,
        isFallback: true,
        syncModeReason: 'field_visibility_restricted',
      }],
      tabDataCollabStatus: 'initial',
      tabDataCollabOnline: false,
      tabDataCollabFallback: true,
      tabDataCollabSyncModeReason: 'field_visibility_restricted',
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('warning')
    expect(collabLine.detail).toContain('受限字段')
    expect(pickCollabIndicatorMessage(collabLine, t)).toEqual({
      tone: 'warning',
      message: '受限字段，使用兼容同步',
    })
  })

  it('明确权限拒绝标红且不展示重连语义', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{
        status: CollabStatus.INITIAL,
        isOnline: false,
        isFallback: true,
        syncModeReason: 'permission_denied',
      }],
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('destructive')
    expect(collabLine.detail).toBe('无权限访问表格协作')
    expect(collabLine.detail).not.toContain('重连')
    expect(pickCollabIndicatorMessage(collabLine, t)).toEqual({
      tone: 'destructive',
      message: '无权限访问表格协作',
    })
  })

  it('父文档引用暂不可验证时显示可恢复警告而非无权限', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{
        status: CollabStatus.INITIAL,
        isOnline: false,
        isFallback: true,
        syncModeReason: 'access_verification_unavailable',
      }],
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('warning')
    expect(collabLine.detail).toBe('暂时无法验证表格协作权限')
    expect(collabLine.detail).not.toContain('无权限')
    expect(pickCollabIndicatorMessage(collabLine, t)).toEqual({
      tone: 'warning',
      message: '暂时无法验证表格协作权限',
    })
  })

  it('TabDoc 用 Y.js collabStatus，不把 event stream connected 当成未打开', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tabDocCollaborating: true,
      tabDocCollabStatus: CollabStatus.SYNCED,
      // Gateway doc.events 订阅态，旧逻辑会误显示「未打开协作文档」
      tabDocEventStreamStatus: 'connected',
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('success')
    expect(collabLine.detail).toBe(t('collab.statusSynced'))
  })

  it('仅有 TabDoc collabStatus=connecting 时也展示协作同步行', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tabDocCollaborating: false,
      tabDocCollabStatus: CollabStatus.CONNECTING,
      tabDocEventStreamStatus: 'idle',
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('warning')
    expect(collabLine.detail).toBe(t('collab.statusConnecting'))
  })

  it('表格健康首次建连不展示全局协作同步提示', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{
        status: CollabStatus.CONNECTING,
        connectionStatus: CollabConnectionStatus.CONNECTING,
        isOnline: false,
      }],
    }, t)

    expect(lines.find((line) => line.id === 'collab')).toBeUndefined()
  })

  it('TabData runtime 健康首次建连不展示全局协作同步提示', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tabDataCollabStatus: CollabStatus.CONNECTING,
      tabDataCollabConnectionStatus: CollabConnectionStatus.CONNECTING,
      tabDataCollabOnline: false,
    }, t)

    expect(lines.find((line) => line.id === 'collab')).toBeUndefined()
  })

  it('表格切换启动期 transient fallback 不展示全局协作同步提示', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{
        status: CollabStatus.INITIAL,
        connectionStatus: CollabConnectionStatus.IDLE,
        isOnline: false,
        isFallback: true,
        syncModeReason: 'collab_unavailable',
      }],
    }, t)

    expect(lines.find((line) => line.id === 'collab')).toBeUndefined()
  })

  it('TabData runtime 启动期 syncing 不展示全局协作同步提示', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tabDataCollabStatus: CollabStatus.SYNCING,
      tabDataCollabConnectionStatus: CollabConnectionStatus.CONNECTED,
      tabDataCollabOnline: true,
    }, t)

    expect(lines.find((line) => line.id === 'collab')).toBeUndefined()
  })

  // ── ：握手持久挂起（STUCK_CONNECTING）──

  it('表格挂起时显示「连接异常」而非无差别「连接中」', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{
        status: CollabStatus.CONNECTING,
        connectionStatus: CollabConnectionStatus.STUCK_CONNECTING,
        isOnline: false,
      }],
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('destructive')
    expect(collabLine.detail).toContain('连接异常，持续重试中')
    // 顶部指示器保留「建议重启应用」原文
    expect(pickCollabIndicatorMessage(collabLine, t)).toEqual({
      tone: 'destructive',
      message: '连接异常，持续重试中（建议重启应用）',
    })
  })

  it('挂起降级（stuck_connecting legacy）归为故障，不落入预期降级的 warning 分支', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{
        status: CollabStatus.CONNECTING,
        connectionStatus: CollabConnectionStatus.STUCK_CONNECTING,
        isOnline: false,
        isFallback: true,
        syncModeReason: 'stuck_connecting',
      }],
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('destructive')
    expect(collabLine.detail).toContain('连接异常，持续重试中')
  })

  it('TabDoc 挂起时同样显示「连接异常」，即使已降级本地编辑', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tabDocCollaborating: true,
      tabDocCollabStatus: CollabStatus.CONNECTING,
      tabDocCollabConnectionStatus: CollabConnectionStatus.STUCK_CONNECTING,
      tabDocCollabFallback: true,
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('destructive')
    expect(collabLine.detail).toContain('连接异常，持续重试中')
  })

  it('TabData 挂起（runtime metrics 通道）同样显示「连接异常」', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tabDataCollabStatus: CollabStatus.CONNECTING,
      tabDataCollabConnectionStatus: CollabConnectionStatus.STUCK_CONNECTING,
      tabDataCollabOnline: false,
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.tone).toBe('destructive')
    expect(collabLine.detail).toContain('连接异常，持续重试中')
  })

  it('正常 RECONNECTING 不触发挂起文案', () => {
    const lines = buildConnectionServiceLines({
      ...baseInput,
      tableCollabStatuses: [{
        status: CollabStatus.CONNECTING,
        connectionStatus: CollabConnectionStatus.RECONNECTING,
        isOnline: false,
      }],
    }, t)

    const collabLine = lines.find((line) => line.id === 'collab')!
    expect(collabLine.detail).toBe(t('collab.statusConnecting'))
    expect(collabLine.detail).not.toContain('连接异常')
  })
})
