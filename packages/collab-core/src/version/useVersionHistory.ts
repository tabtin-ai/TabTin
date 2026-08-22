/**
 * useVersionHistory — 统一版本历史 Hook
 *
 * 合并了原 collab-core 和 Electron 级两套实现，提供：
 * - 版本列表获取（支持分页、namedOnly 过滤）
 * - 命名版本创建 / 恢复 / 重命名 / 取消命名 / 置顶
 * - 统一的 OperationResult 错误处理
 * - 恢复后延迟刷新（消除竞态 CC-023）
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { joinApiPath } from "@tabtin/config"
import type { VersionHistoryItem } from "./types"

export interface OperationResult {
  success: boolean
  error?: string
  /**
   * force-close 失败时后端返回的警告。
   * "force_close_failed"：在线用户 Y.Doc 未被强制关闭，下次 onStore 可能覆盖恢复数据。
   * "document_not_loaded"：文档未加载，无需 force-close（正常情况）。
   */
  warning?: "force_close_failed" | "document_not_loaded" | string
}

export interface UseVersionHistoryOptions {
  /** 资源类型, e.g. "tabdoc" | "design" | "slide" | "video" | "canvas" */
  resourceType: string
  /** 资源 ID, null 时 Hook 不活跃 */
  resourceId: string | null
  /** collab API base URL, e.g. "http://localhost:6060/api/collab/v1" */
  apiBase: string
  /** JWT token */
  token: string
  /** 是否启用（resourceId 有效且业务允许时传 true） */
  enabled?: boolean
  /** 挂载时自动拉取 */
  autoFetch?: boolean
  /** 每页条数 */
  pageSize?: number
  /** 统一错误回调 */
  onError?: (error: Error, operation: string) => void
  /**
   * 恢复成功后的回调。
   * info.syncMode 由后端返回：
   * - "resync"：服务端已通过 Yjs 增量广播还原内容，客户端无需 forceReconnect；
   * - "force_close"/未提供：调用方应触发 CollabProvider.forceReconnect()，丢弃本地 Y.Doc 重拉。
   */
  onRestoreSuccess?: (info?: { syncMode?: string }) => void
  /**
   * 恢复成功后延迟多久再刷新版本列表（ms）。
   * 后端恢复操作涉及 PG 写回 + Hocuspocus 热重载，存在异步延迟。
   * 默认 800ms。设为 0 则立即刷新。
   */
  refreshDelayAfterRestore?: number
}

export interface UseVersionHistoryReturn {
  versions: VersionHistoryItem[]
  total: number
  loading: boolean
  error: string | null
  hasMore: boolean
  restoringVersion: string | null
  /**
   * CLB-016: restore 成功后后端返回的新快照 ID。
   * 调用方可用此 ID 在版本列表中高亮"当前版本"。
   * 初始为 null，首次 restore 成功后更新。
   */
  currentVersionId: string | null

  fetchVersions: (opts?: { namedOnly?: boolean; offset?: number }) => Promise<void>
  createNamedVersion: (name: string) => Promise<OperationResult>
  restoreVersion: (versionId: string) => Promise<OperationResult>
  renameVersion: (versionId: string, name: string) => Promise<OperationResult>
  /** 清除命名版本的名称（语义上 "unname"，而非删除版本本身） */
  unnameVersion: (versionId: string) => Promise<OperationResult>
  togglePin: (versionId: string, pinned: boolean, opts?: { namedOnly?: boolean }) => Promise<OperationResult>
}

const DEFAULT_REFRESH_DELAY = 800
const READONLY_VERSION_ERROR = "当前为只读权限，需要可编辑权限才能操作版本历史"

/** 版本写接口错误只向用户暴露可读 message，避免把整个 JSON 响应渲染进面板。 */
export async function readVersionOperationError(
  response: Response,
  fallback: string,
): Promise<string> {
  const text = await response.text().catch(() => "")
  if (response.status === 403) return READONLY_VERSION_ERROR
  if (text) {
    try {
      const body = JSON.parse(text) as { message?: unknown; detail?: unknown }
      if (typeof body.message === "string" && body.message.trim()) return body.message
      if (typeof body.detail === "string" && body.detail.trim()) return body.detail
    } catch {
      return text
    }
  }
  return fallback || `HTTP ${response.status}`
}

export function useVersionHistory(options: UseVersionHistoryOptions): UseVersionHistoryReturn {
  const {
    resourceType,
    resourceId,
    apiBase,
    token,
    enabled = true,
    autoFetch = true,
    pageSize = 50,
    onError,
    refreshDelayAfterRestore = DEFAULT_REFRESH_DELAY,
  } = options

  const [versions, setVersions] = useState<VersionHistoryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoringVersion, setRestoringVersion] = useState<string | null>(null)
  // CLB-016: 记录最近一次 restore 操作产生的新快照 ID，用于高亮"当前版本"
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const restoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const optionsRef = useRef(options)
  optionsRef.current = options

  const headers = useCallback(
    () => ({
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    }),
    [token],
  )

  const buildBase = useCallback(() => {
    if (!resourceId) return null
    return joinApiPath(apiBase, `/${resourceType}/${resourceId}`)
  }, [apiBase, resourceType, resourceId])

  const reportError = useCallback(
    (err: Error, operation: string) => {
      optionsRef.current.onError?.(err, operation)
    },
    [],
  )

  // ── fetchVersions ─────────────────────────────────────
  const fetchVersions = useCallback(
    async (opts?: { namedOnly?: boolean; offset?: number }) => {
      const base = buildBase()
      if (!base || !enabled) return

      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          limit: String(pageSize),
          offset: String(opts?.offset ?? 0),
        })
        if (opts?.namedOnly) params.set("named_only", "true")

        const res = await fetch(`${base}/versions?${params}`, { headers: headers() })
        const json = await res.json()
        if (!mountedRef.current) return

        if (json.status === "ok") {
          const offset = opts?.offset ?? 0
          const items: VersionHistoryItem[] = json.data ?? []
          setVersions(offset > 0 ? (prev) => [...prev, ...items] : items)
          setTotal(json.total ?? 0)
        } else {
          const msg = json.message || "Failed to fetch versions"
          setError(msg)
          reportError(new Error(msg), "fetchVersions")
        }
      } catch (e: any) {
        if (mountedRef.current) {
          setError(e.message)
          reportError(e, "fetchVersions")
        }
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    },
    [buildBase, enabled, headers, pageSize, reportError],
  )

  // ── createNamedVersion ────────────────────────────────
  const createNamedVersion = useCallback(
    async (name: string): Promise<OperationResult> => {
      const base = buildBase()
      if (!base) return { success: false, error: "No resource ID" }
      try {
        const res = await fetch(`${base}/versions`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ name }),
        })
        if (!res.ok) {
          const errMsg = await readVersionOperationError(res, "Create failed")
          reportError(new Error(errMsg), "createNamedVersion")
          return { success: false, error: errMsg }
        }
        const json = await res.json().catch(() => ({}))
        if (json.status === "error") {
          reportError(new Error(json.message), "createNamedVersion")
          return { success: false, error: json.message || "Create failed" }
        }
        await fetchVersions()
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error"
        reportError(new Error(msg), "createNamedVersion")
        return { success: false, error: msg }
      }
    },
    [buildBase, headers, fetchVersions, reportError],
  )

  // ── restoreVersion (CC-023: 延迟刷新) ────────────────
  const restoreVersion = useCallback(
    async (versionId: string): Promise<OperationResult> => {
      const base = buildBase()
      if (!base) return { success: false, error: "No resource ID" }

      setRestoringVersion(versionId)
      try {
        const res = await fetch(`${base}/restore`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ version_id: versionId }),
        })
        if (!res.ok) {
          const errMsg = await readVersionOperationError(res, "Restore failed")
          reportError(new Error(errMsg), "restoreVersion")
          return { success: false, error: errMsg }
        }
        const json = await res.json().catch(() => ({}))
        if (json.status === "error") {
          reportError(new Error(json.message), "restoreVersion")
          return { success: false, error: json.message || "Restore failed" }
        }

        // FAR-009 / CLB-002: 读取 force-close 警告字段
        const warning: string | undefined = json.data?.collab_sync_warning

        // : 读取后端同步模式（resync 时客户端无需 forceReconnect）
        const syncMode: string | undefined = json.data?.sync_mode

        // CLB-016: 读取后端返回的新快照 ID，用于版本列表高亮"当前版本"
        const newVersionId: string | null = json.data?.version_id ?? json.version_id ?? null
        if (newVersionId && mountedRef.current) {
          setCurrentVersionId(newVersionId)
        }

        // 通知协作层：force_close 兜底时执行 forceReconnect；resync 时跳过
        try {
          optionsRef.current.onRestoreSuccess?.({ syncMode })
        } catch (cbErr) {
          console.warn("[useVersionHistory] onRestoreSuccess callback error:", cbErr)
        }

        // CC-023: 延迟刷新——后端恢复操作涉及异步写回，立即刷新可能拿到旧快照
        const delay = optionsRef.current.refreshDelayAfterRestore ?? DEFAULT_REFRESH_DELAY
        if (delay > 0) {
          if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current)
          restoreTimeoutRef.current = setTimeout(() => {
            restoreTimeoutRef.current = null
            if (mountedRef.current) void fetchVersions()
          }, delay)
        } else {
          await fetchVersions()
        }

        return { success: true, ...(warning ? { warning } : {}) }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error"
        reportError(new Error(msg), "restoreVersion")
        return { success: false, error: msg }
      } finally {
        if (mountedRef.current) setRestoringVersion(null)
      }
    },
    [buildBase, headers, fetchVersions, reportError],
  )

  // ── renameVersion ─────────────────────────────────────
  const renameVersion = useCallback(
    async (versionId: string, name: string): Promise<OperationResult> => {
      const base = buildBase()
      if (!base) return { success: false, error: "No resource ID" }
      try {
        const res = await fetch(`${base}/versions/${versionId}/name`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ name }),
        })
        if (!res.ok) {
          const errMsg = await readVersionOperationError(res, "Rename failed")
          reportError(new Error(errMsg), "renameVersion")
          return { success: false, error: errMsg }
        }
        const json = await res.json().catch(() => ({}))
        if (json.status === "error") {
          reportError(new Error(json.message), "renameVersion")
          return { success: false, error: json.message || "Rename failed" }
        }
        await fetchVersions()
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error"
        reportError(new Error(msg), "renameVersion")
        return { success: false, error: msg }
      }
    },
    [buildBase, headers, fetchVersions, reportError],
  )

  // ── unnameVersion (CC-022: 明确的取消命名语义) ────────
  const unnameVersion = useCallback(
    async (versionId: string): Promise<OperationResult> => {
      const base = buildBase()
      if (!base) return { success: false, error: "No resource ID" }
      try {
        const res = await fetch(`${base}/versions/${versionId}/name`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ name: "" }),
        })
        if (!res.ok) {
          const errMsg = await readVersionOperationError(res, "Unname failed")
          reportError(new Error(errMsg), "unnameVersion")
          return { success: false, error: errMsg }
        }
        const json = await res.json().catch(() => ({}))
        if (json.status === "error") {
          reportError(new Error(json.message), "unnameVersion")
          return { success: false, error: json.message || "Unname failed" }
        }
        await fetchVersions()
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error"
        reportError(new Error(msg), "unnameVersion")
        return { success: false, error: msg }
      }
    },
    [buildBase, headers, fetchVersions, reportError],
  )

  // ── togglePin ─────────────────────────────────────────
  const togglePin = useCallback(
    async (versionId: string, pinned: boolean, opts?: { namedOnly?: boolean }): Promise<OperationResult> => {
      const base = buildBase()
      if (!base) return { success: false, error: "No resource ID" }
      try {
        const res = await fetch(`${base}/versions/${versionId}/pin`, {
          method: "PATCH",
          headers: headers(),
          body: JSON.stringify({ pinned }),
        })
        if (!res.ok) {
          const errMsg = await readVersionOperationError(res, "Toggle pin failed")
          reportError(new Error(errMsg), "togglePin")
          return { success: false, error: errMsg }
        }
        const json = await res.json().catch(() => ({}))
        if (json.status === "error") {
          reportError(new Error(json.message), "togglePin")
          return { success: false, error: json.message || "Toggle pin failed" }
        }
        await fetchVersions(opts)
        return { success: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error"
        reportError(new Error(msg), "togglePin")
        return { success: false, error: msg }
      }
    },
    [buildBase, headers, fetchVersions, reportError],
  )

  // ── 自动拉取 + 清理 ──────────────────────────────────
  useEffect(() => {
    mountedRef.current = true
    if (autoFetch && resourceId && enabled) {
      void fetchVersions()
    }
    return () => {
      mountedRef.current = false
      if (restoreTimeoutRef.current) {
        clearTimeout(restoreTimeoutRef.current)
        restoreTimeoutRef.current = null
      }
    }
  }, [autoFetch, resourceId, enabled, fetchVersions])

  const hasMore = versions.length < total

  return {
    versions,
    total,
    loading,
    error,
    hasMore,
    restoringVersion,
    currentVersionId,
    fetchVersions,
    createNamedVersion,
    restoreVersion,
    renameVersion,
    unnameVersion,
    togglePin,
  }
}
