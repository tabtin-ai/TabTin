import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { LocalMcpConnectionSummary, LocalMcpDiscoveryResult } from '@shared/types/mcp'

// ER-9: 模块级 in-flight + 短 TTL 缓存。
// 修复前：ProfileModulePreviews 同时挂载 McpPreview + useMcpPreviewMeta + McpPanel
// 时，每个 hook 实例 useEffect 各自跑 IPC（discover/listConnections），
// 同一窗口出现 2× 重复（IPC Inspector 实测）。
// 修复后：同窗口内所有 hook 共享一次 IPC 结果。
// IPC 都不带 agentId 参数 → 缓存可以全局共享（agentId 仅用于本地过滤）。
type PanelLoadResults = readonly [
  PromiseSettledResult<LocalMcpDiscoveryResult>,
  PromiseSettledResult<LocalMcpConnectionSummary[]>,
]

const SHARED_TTL_MS = 1000
let inflightLoad: Promise<PanelLoadResults> | null = null
let cachedLoad: { results: PanelLoadResults; expiresAt: number } | null = null

const fetchPanelDataDeduped = (mode: 'initial' | 'refresh'): Promise<PanelLoadResults> => {
  // 'refresh' 强制绕过缓存（用户手动点刷新时不该看 stale）
  if (mode !== 'refresh') {
    const now = Date.now()
    if (cachedLoad && cachedLoad.expiresAt > now) {
      return Promise.resolve(cachedLoad.results)
    }
    if (inflightLoad) return inflightLoad
  }

  const promise = Promise.allSettled([
    window.tabtin.localMcp.discover() as Promise<LocalMcpDiscoveryResult>,
    window.tabtin.localMcp.listConnections() as Promise<LocalMcpConnectionSummary[]>,
  ]).then((results) => {
    const tuple = results as unknown as PanelLoadResults
    cachedLoad = { results: tuple, expiresAt: Date.now() + SHARED_TTL_MS }
    return tuple
  }).finally(() => {
    if (inflightLoad === promise) inflightLoad = null
  })

  // refresh 也允许并发的 initial caller 复用，避免 refresh + 新挂载的 initial 重复打 IPC
  inflightLoad = promise
  return promise
}

const writeCachedConnections = (next: LocalMcpConnectionSummary[]): void => {
  if (!cachedLoad) {
    cachedLoad = {
      results: [
        { status: 'fulfilled', value: { timestamp: Date.now(), candidates: [] } },
        { status: 'fulfilled', value: next },
      ],
      expiresAt: Date.now() + SHARED_TTL_MS,
    }
    return
  }
  const discoveryResult = cachedLoad.results[0]
  cachedLoad = {
    results: [
      discoveryResult,
      { status: 'fulfilled', value: next },
    ],
    expiresAt: Date.now() + SHARED_TTL_MS,
  }
}

const patchDiscoveryAttachedAgents = (
  discovery: LocalMcpDiscoveryResult | null,
  updated: LocalMcpConnectionSummary,
): LocalMcpDiscoveryResult | null => {
  if (!discovery) return discovery
  let changed = false
  const candidates = discovery.candidates.map(candidate => {
    if (candidate.importedConnectionId !== updated.id) return candidate
    changed = true
    return {
      ...candidate,
      attachedAgentIds: [...updated.attachedAgentIds],
    }
  })
  return changed ? { ...discovery, candidates } : discovery
}

/** 测试钩子：重置模块级缓存。 */
export const __testingMcpPanelDataCache = {
  reset(): void {
    inflightLoad = null
    cachedLoad = null
  },
}

/**
 * @param agentId 可选。设备域调用方不传；传入时 activeAttachedConnections
 *   会过滤出「已启用给该 Agent」的连接。
 */
export function useMcpPanelData(agentId?: string) {
  const { t } = useTranslation('space')

  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<LocalMcpDiscoveryResult | null>(null)
  const [connections, setConnections] = useState<LocalMcpConnectionSummary[]>([])

  const loadPanelData = useCallback(async (
    mode: 'initial' | 'refresh' = 'initial',
  ): Promise<LocalMcpConnectionSummary[] | null> => {
    if (mode === 'initial') {
      setLoading(true)
    } else {
      setRefreshing(true)
    }

    const results = await fetchPanelDataDeduped(mode)

    const failures = results.filter(result => result.status === 'rejected').length
    if (failures === 0) {
      setError(null)
    } else if (failures < results.length) {
      setError(t('mcpConnections.partialError', {
        defaultValue: '部分 MCP 信息加载失败，下面展示的是当前已读取成功的数据。',
      }))
    } else {
      setError(t('mcpConnections.loadFailed', {
        defaultValue: 'MCP 信息加载失败，请稍后重试。',
      }))
    }

    const discoveryResult = results[0]
    if (discoveryResult.status === 'fulfilled') {
      setDiscovery(discoveryResult.value)
    } else if (mode === 'initial') {
      setDiscovery({ timestamp: Date.now(), candidates: [] })
    }

    const connectionsResult = results[1]
    let nextConnections: LocalMcpConnectionSummary[] | null = null
    if (connectionsResult.status === 'fulfilled') {
      nextConnections = connectionsResult.value
      setConnections(nextConnections)
    } else if (mode === 'initial') {
      setConnections([])
    }

    setLoading(false)
    setRefreshing(false)
    return nextConnections
  }, [t])

  /**
   * 挂载 / 启停 / 探测成功后局部写入，避免 loadPanelData('refresh') 重跑 discover
   * 导致列表整页闪一下。
   */
  const upsertConnection = useCallback((updated: LocalMcpConnectionSummary) => {
    setConnections(prev => {
      const idx = prev.findIndex(connection => connection.id === updated.id)
      const next = idx >= 0
        ? prev.map(connection => (connection.id === updated.id ? updated : connection))
        : [updated, ...prev]
      writeCachedConnections(next)
      return next
    })
    setDiscovery(prev => patchDiscoveryAttachedAgents(prev, updated))
  }, [])

  /**
   * 仅重拉 connections（不 discover、不翻 refreshing）。
   * 并行 attach 后用于对齐真实落盘，避免竞态丢挂载。
   */
  const refreshConnectionsSilent = useCallback(async (): Promise<LocalMcpConnectionSummary[] | null> => {
    try {
      const next = await window.tabtin.localMcp.listConnections() as LocalMcpConnectionSummary[]
      setConnections(next)
      writeCachedConnections(next)
      setDiscovery(prev => {
        if (!prev) return prev
        const byId = new Map(next.map(connection => [connection.id, connection]))
        let changed = false
        const candidates = prev.candidates.map(candidate => {
          const importedId = candidate.importedConnectionId
          if (!importedId) return candidate
          const matched = byId.get(importedId)
          if (!matched) return candidate
          const same =
            (candidate.attachedAgentIds?.length ?? 0) === matched.attachedAgentIds.length
            && (candidate.attachedAgentIds ?? []).every((id, index) => id === matched.attachedAgentIds[index])
          if (same) return candidate
          changed = true
          return { ...candidate, attachedAgentIds: [...matched.attachedAgentIds] }
        })
        return changed ? { ...prev, candidates } : prev
      })
      return next
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    void loadPanelData('initial')
  }, [loadPanelData])

  const connectionMap = useMemo(
    () => new Map(connections.map(connection => [connection.id, connection])),
    [connections],
  )

  const activeAttachedConnections = useMemo(
    () => agentId
      ? connections.filter(connection => connection.enabled && connection.attachedAgentIds.includes(agentId))
      : [],
    [agentId, connections],
  )

  return {
    loading,
    refreshing,
    error,
    discovery,
    connections,
    connectionMap,
    activeAttachedConnections,
    loadPanelData,
    upsertConnection,
    refreshConnectionsSilent,
  }
}
