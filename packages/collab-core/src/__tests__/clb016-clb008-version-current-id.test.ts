/**
 * CLB-016 / CLB-008 回归测试
 *
 * CLB-016: restoreVersion 应读取后端响应的 version_id，
 *          并通过 currentVersionId 暴露给调用方。
 *
 * CLB-008: VersionPanel 应根据 currentVersionId 高亮当前版本条目。
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

function makeRestoreResponse(versionId: string) {
  return {
    ok: true,
    json: async () => ({
      status: "ok",
      data: { version_id: versionId },
    }),
  }
}

function makeRestoreResponseLegacy(versionId: string) {
  // 旧格式：version_id 在顶层（非 data 嵌套）
  return {
    ok: true,
    json: async () => ({
      status: "ok",
      version_id: versionId,
    }),
  }
}

const BASE_OPTIONS = {
  resourceType: "video",
  resourceId: "res-001",
  apiBase: "http://localhost:6060/api/collab/v1",
  token: "test-token",
  enabled: true,
  autoFetch: false,
}

// ── 测试套件 ─────────────────────────────────────────────────────────────────

describe("CLB-016: useVersionHistory.currentVersionId", () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it("初始状态下 currentVersionId 为 null", () => {
    const { result } = renderHook(() => useVersionHistory(BASE_OPTIONS))
    expect(result.current.currentVersionId).toBeNull()
  })

  it("restore 成功后应从响应 data.version_id 读取并更新 currentVersionId", async () => {
    const newVersionId = "vh-new-001"
    // autoFetch: false，所以只有 restore 请求和延迟刷新的 versions 请求
    mockFetch
      .mockResolvedValueOnce(makeRestoreResponse(newVersionId))  // POST /restore
      .mockResolvedValueOnce(makeVersionsResponse())             // 延迟刷新 GET /versions

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, refreshDelayAfterRestore: 0 })
    )

    await act(async () => {
      await result.current.restoreVersion("vh-old-001")
    })

    expect(result.current.currentVersionId).toBe(newVersionId)
  })

  it("restore 成功后应从响应顶层 version_id 读取（兼容旧格式）", async () => {
    const newVersionId = "vh-new-legacy-001"
    mockFetch
      .mockResolvedValueOnce(makeRestoreResponseLegacy(newVersionId))
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, refreshDelayAfterRestore: 0 })
    )

    await act(async () => {
      await result.current.restoreVersion("vh-old-001")
    })

    expect(result.current.currentVersionId).toBe(newVersionId)
  })

  it("restore 失败时不应更新 currentVersionId", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: async () => "Server Error",
    })

    const { result } = renderHook(() => useVersionHistory(BASE_OPTIONS))

    await act(async () => {
      await result.current.restoreVersion("vh-old-001")
    })

    expect(result.current.currentVersionId).toBeNull()
  })

  it("restore 响应无 version_id 时 currentVersionId 保持 null", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ok", data: {} }),
      })
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, refreshDelayAfterRestore: 0 })
    )

    await act(async () => {
      await result.current.restoreVersion("vh-old-001")
    })

    expect(result.current.currentVersionId).toBeNull()
  })

  it("多次 restore 应更新 currentVersionId 为最新的快照 ID", async () => {
    mockFetch
      .mockResolvedValueOnce(makeRestoreResponse("vh-first"))
      .mockResolvedValueOnce(makeVersionsResponse())
      .mockResolvedValueOnce(makeRestoreResponse("vh-second"))
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, refreshDelayAfterRestore: 0 })
    )

    await act(async () => {
      await result.current.restoreVersion("vh-old-001")
    })
    expect(result.current.currentVersionId).toBe("vh-first")

    await act(async () => {
      await result.current.restoreVersion("vh-old-002")
    })
    expect(result.current.currentVersionId).toBe("vh-second")
  })

  it("onRestoreSuccess 回调应在 currentVersionId 更新后被调用", async () => {
    const newVersionId = "vh-callback-test"
    const onRestoreSuccess = vi.fn()

    mockFetch
      .mockResolvedValueOnce(makeRestoreResponse(newVersionId))
      .mockResolvedValueOnce(makeVersionsResponse())

    const { result } = renderHook(() =>
      useVersionHistory({ ...BASE_OPTIONS, onRestoreSuccess, refreshDelayAfterRestore: 0 })
    )

    await act(async () => {
      await result.current.restoreVersion("vh-old-001")
    })

    expect(onRestoreSuccess).toHaveBeenCalledTimes(1)
    expect(result.current.currentVersionId).toBe(newVersionId)
  })
})
