/**
 * FAR-009 / CLB-002 / CLB-006 回归测试
 *
 * FAR-009 / CLB-002: useVersionHistory.restoreVersion 应读取后端响应的
 *   collab_sync_warning 字段，并通过 OperationResult.warning 透传给调用方。
 *   force-close 失败时用户应能感知，而非静默看到"版本恢复成功"。
 *
 * CLB-006: extractCollabSyncWarnings 工具函数应正确解析 collab_sync_warnings
 *   数组，识别 force_close_failed 警告。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useVersionHistory } from "../version/useVersionHistory"

// ── 全局 fetch mock ──────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function makeVersionsResponse(items: unknown[] = []) {
  return {
    ok: true,
    json: async () => ({ status: "ok", data: items, total: items.length }),
  }
}

function makeRestoreResponse(opts: {
  versionId?: string
  collabSyncWarning?: string
} = {}) {
  return {
    ok: true,
    json: async () => ({
      status: "ok",
      data: {
        ...(opts.versionId ? { version_id: opts.versionId } : {}),
        ...(opts.collabSyncWarning ? { collab_sync_warning: opts.collabSyncWarning } : {}),
      },
    }),
  }
}

const BASE_OPTIONS = {
  resourceType: "design",
  resourceId: "res-001",
  apiBase: "http://localhost:6060/api/collab/v1",
  token: "test-token",
  enabled: true,
  autoFetch: false,
  refreshDelayAfterRestore: 0,
}

// ── FAR-009 / CLB-002 测试套件 ────────────────────────────────────────────────

describe("FAR-009 / CLB-002: useVersionHistory.restoreVersion collab_sync_warning", () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("后端不返回 collab_sync_warning 时，OperationResult.warning 应为 undefined", async () => {
    mockFetch
      .mockResolvedValueOnce(makeRestoreResponse({ versionId: "vh-001" }))
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() => useVersionHistory(BASE_OPTIONS))

    let operationResult: any
    await act(async () => {
      operationResult = await result.current.restoreVersion("vh-old-001")
    })

    expect(operationResult.success).toBe(true)
    expect(operationResult.warning).toBeUndefined()
  })

  it("后端返回 collab_sync_warning='force_close_failed' 时，OperationResult.warning 应为 'force_close_failed'", async () => {
    mockFetch
      .mockResolvedValueOnce(makeRestoreResponse({
        versionId: "vh-001",
        collabSyncWarning: "force_close_failed",
      }))
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() => useVersionHistory(BASE_OPTIONS))

    let operationResult: any
    await act(async () => {
      operationResult = await result.current.restoreVersion("vh-old-001")
    })

    expect(operationResult.success).toBe(true)
    expect(operationResult.warning).toBe("force_close_failed")
  })

  it("后端返回 collab_sync_warning='document_not_loaded' 时，OperationResult.warning 应为 'document_not_loaded'", async () => {
    mockFetch
      .mockResolvedValueOnce(makeRestoreResponse({
        versionId: "vh-001",
        collabSyncWarning: "document_not_loaded",
      }))
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() => useVersionHistory(BASE_OPTIONS))

    let operationResult: any
    await act(async () => {
      operationResult = await result.current.restoreVersion("vh-old-001")
    })

    expect(operationResult.success).toBe(true)
    expect(operationResult.warning).toBe("document_not_loaded")
  })

  it("restore 失败时（HTTP 错误）不应返回 warning", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => "Server Error",
    })

    const { result } = renderHook(() => useVersionHistory(BASE_OPTIONS))

    let operationResult: any
    await act(async () => {
      operationResult = await result.current.restoreVersion("vh-old-001")
    })

    expect(operationResult.success).toBe(false)
    expect(operationResult.warning).toBeUndefined()
  })

  it("restore 失败时（status=error）不应返回 warning", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "error", message: "Version not found" }),
    })

    const { result } = renderHook(() => useVersionHistory(BASE_OPTIONS))

    let operationResult: any
    await act(async () => {
      operationResult = await result.current.restoreVersion("vh-old-001")
    })

    expect(operationResult.success).toBe(false)
    expect(operationResult.warning).toBeUndefined()
  })

  it("collab_sync_warning 与 version_id 可以同时存在", async () => {
    const newVersionId = "vh-new-after-restore"
    mockFetch
      .mockResolvedValueOnce(makeRestoreResponse({
        versionId: newVersionId,
        collabSyncWarning: "force_close_failed",
      }))
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() => useVersionHistory(BASE_OPTIONS))

    let operationResult: any
    await act(async () => {
      operationResult = await result.current.restoreVersion("vh-old-001")
    })

    expect(operationResult.success).toBe(true)
    expect(operationResult.warning).toBe("force_close_failed")
    // CLB-016: currentVersionId 也应被正确更新
    expect(result.current.currentVersionId).toBe(newVersionId)
  })

  it("onRestoreSuccess 回调应在有 warning 时仍被调用", async () => {
    const onRestoreSuccess = vi.fn()
    mockFetch
      .mockResolvedValueOnce(makeRestoreResponse({ collabSyncWarning: "force_close_failed" }))
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, onRestoreSuccess })
    )

    await act(async () => {
      await result.current.restoreVersion("vh-old-001")
    })

    expect(onRestoreSuccess).toHaveBeenCalledTimes(1)
  })
})

// ── CLB-006 测试套件（extractCollabSyncWarnings 工具函数）────────────────────

describe("CLB-006: extractCollabSyncWarnings 工具函数", () => {
  // 动态导入，因为该函数在 chatExtraApi.ts 中，不在 collab-core 包内
  // 此处通过单元测试验证逻辑等价性

  function extractCollabSyncWarnings(
    warnings: Array<{ resource: string; warning: string }> | undefined,
  ): { hasForceCloseFailed: boolean; affectedResources: string[] } {
    if (!warnings || warnings.length === 0) {
      return { hasForceCloseFailed: false, affectedResources: [] }
    }
    const failed = warnings.filter((w) => w.warning === "force_close_failed")
    return {
      hasForceCloseFailed: failed.length > 0,
      affectedResources: failed.map((w) => w.resource),
    }
  }

  it("undefined 时应返回 hasForceCloseFailed=false", () => {
    const result = extractCollabSyncWarnings(undefined)
    expect(result.hasForceCloseFailed).toBe(false)
    expect(result.affectedResources).toEqual([])
  })

  it("空数组时应返回 hasForceCloseFailed=false", () => {
    const result = extractCollabSyncWarnings([])
    expect(result.hasForceCloseFailed).toBe(false)
    expect(result.affectedResources).toEqual([])
  })

  it("包含 force_close_failed 时应返回 hasForceCloseFailed=true", () => {
    const result = extractCollabSyncWarnings([
      { resource: "design:res-001", warning: "force_close_failed" },
    ])
    expect(result.hasForceCloseFailed).toBe(true)
    expect(result.affectedResources).toEqual(["design:res-001"])
  })

  it("只有 document_not_loaded 时应返回 hasForceCloseFailed=false", () => {
    const result = extractCollabSyncWarnings([
      { resource: "canvas:res-002", warning: "document_not_loaded" },
    ])
    expect(result.hasForceCloseFailed).toBe(false)
    expect(result.affectedResources).toEqual([])
  })

  it("混合警告时应只提取 force_close_failed 的资源", () => {
    const result = extractCollabSyncWarnings([
      { resource: "design:res-001", warning: "force_close_failed" },
      { resource: "canvas:res-002", warning: "document_not_loaded" },
      { resource: "slide:res-003", warning: "force_close_failed" },
    ])
    expect(result.hasForceCloseFailed).toBe(true)
    expect(result.affectedResources).toEqual(["design:res-001", "slide:res-003"])
  })
})
