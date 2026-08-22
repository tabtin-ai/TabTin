import { useCallback, useEffect, useRef, useState } from 'react'
import type { Table } from '@tabtin/table-core'

const LOADING_TIMEOUT_MS = 3_000

/** 详情接口回填的权限/标题与 per-tab selectedTable 不一致时需 force 同步。 */
function tableMetadataNeedsResync(selected: Table, latest: Table): boolean {
  return (
    selected.current_user_role !== latest.current_user_role
    || selected.name !== latest.name
  )
}

function parseTableUpdatedAtMs(table: Table): number {
  const parsed = Date.parse(table.updated_at ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * per-tab selectedTable 与 globalTables 条目不一致时，选出更新的那份元数据。
 * - 优先比较 `updated_at`（本地 updateTable 成功后 per-tab 会更新，全局缓存可能滞后）
 * - 时间戳相同且仅权限字段不一致时，以 global（服务端详情）为准
 * - 其余平手回退到 per-tab（避免本地刚提交的重命名被旧全局覆盖）
 */
export function pickFresherTableMetadata(perTabTable: Table, globalTable: Table): Table {
  const perTabUpdatedAt = parseTableUpdatedAtMs(perTabTable)
  const globalUpdatedAt = parseTableUpdatedAtMs(globalTable)
  if (perTabUpdatedAt !== globalUpdatedAt) {
    return perTabUpdatedAt > globalUpdatedAt ? perTabTable : globalTable
  }
  if (perTabTable.current_user_role !== globalTable.current_user_role) {
    return globalTable
  }
  return perTabTable
}

function logInit(
  level: 'debug' | 'warn' | 'error',
  message: string,
  payload: Record<string, unknown>,
): void {
  const args = [`[useTableInitFlow] ${message}`, payload]
  if (level === 'error') {
    console.error(...args)
    return
  }
  if (level === 'warn') {
    console.warn(...args)
    return
  }
  // debug：开发可见；Electron 侧 console 拦截仍会进诊断包环形缓冲
  console.debug(...args)
}

export interface UseTableInitFlowDeps {
  tableId: string
  /** 全局 table 列表（用于快速查找已缓存的表） */
  globalTables: readonly Table[]
  /** 从后端获取单张表的元数据 */
  getGlobalTable: (id: string) => Promise<Table | null | undefined>
  /** 将表注入本地 store（供 DataGrid 消费） */
  selectTable: (table: Table, options?: { force?: boolean }) => void
  /** 本地 store 中当前选中的表 */
  selectedTable: Table | null
  /** 初始化 ViewStore（加载视图列表 + 首屏记录） */
  initializeView: (tableId: string, options?: { defaultViewId?: string }) => Promise<void>
  /** ViewStore 当前绑定的 tableId */
  viewTableId: string | null
  /** ViewStore 当前激活的 viewId */
  currentViewId: string | null
  /** ViewStore 是否正在加载 */
  viewLoading: boolean
  /**
   * 表确认就绪后的钩子。
   * Web 端用此加载 fields（当 selectedTable 已匹配但 fields 为空时）。
   * Electron 端一般不需要。
   */
  onTableReady?: (tableId: string, table: Table) => void
  /**
   * 是否为当前活跃的标签页。
   * 为 false 时延迟 initializeView 直到变为 true，避免 Space 加载时所有表同时请求。
   * 默认 true（向后兼容）。
   */
  isActive?: boolean
}

export interface UseTableInitFlowResult {
  /** 当前可渲染的表对象（只允许当前 tableId 对应的 selectedTable > tableRef > globalTable） */
  displayTable: Table | null
  /** 视图初始化是否进行中 */
  isLoading: boolean
  /** 获取表元数据是否失败 */
  fetchFailed: boolean
  /** 综合判断：是否应显示全屏 loading */
  showPaneLoading: boolean
  /** loading 超过阈值，应显示重试按钮 */
  loadingTimedOut: boolean
  /** 强制重置所有状态并重新初始化 */
  handleForceRetry: () => void
}

/**
 * 表格面板的初始化编排 hook。
 *
 * 统一 Electron / Web / AdminDash 的初始化流程：
 * 1. 从 globalTables 查找或远程拉取表元数据
 * 2. 注入本地 tableStore
 * 3. 初始化 viewStore（加载视图 + 首屏记录）
 * 4. 管理 loading / timeout / error / retry 状态
 */
export function useTableInitFlow(deps: UseTableInitFlowDeps): UseTableInitFlowResult {
  const {
    tableId,
    globalTables,
    getGlobalTable,
    selectTable,
    selectedTable,
    initializeView,
    viewTableId,
    currentViewId,
    onTableReady,
    isActive = true,
  } = deps

  const tableRef = useRef<Table | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [fetchFailed, setFetchFailed] = useState(false)
  /** 视图初始化失败（表元数据可能已有）。用于超时页展示重试，避免静默卡在「正在准备」。 */
  const [viewInitFailed, setViewInitFailed] = useState(false)

  const initializedRef = useRef<{
    tableId: string | null
    viewInitialized: boolean
    viewInitializing: boolean
  }>({
    tableId: null,
    viewInitialized: false,
    viewInitializing: false,
  })
  /** 忽略 Strict Mode / 快速重试 / park 留下的过期 initialize 回调 */
  const initEpochRef = useRef(0)
  /** 本轮 active 生命周期内是否已尝试过 initialize（用于 resolve 但无 viewId 的可恢复失败） */
  const initAttemptedRef = useRef(false)

  const table = globalTables.find(item => item.id === tableId) || null
  const selectedTableForCurrent = selectedTable?.id === tableId ? selectedTable : null
  const tableLoadRef = useRef<string | null>(null)
  const tableRefreshRef = useRef<string | null>(null)

  // ── Step 1: 拉取当前表详情 ──
  // globalTables 里的表可能来自旧持久缓存或团队列表，current_user_role / title
  // 对共享表格必须以详情接口为准；当前激活 tab 至少刷新一次。
  useEffect(() => {
    if (!tableId) return
    const shouldFetch = !table || (isActive && tableRefreshRef.current !== tableId)
    if (!shouldFetch) return
    if (tableLoadRef.current === tableId) return
    tableLoadRef.current = tableId
    tableRefreshRef.current = tableId
    setFetchFailed(false)
    let cancelled = false
    void getGlobalTable(tableId)
      .then(result => {
        if (!cancelled && !result) setFetchFailed(true)
      })
      .catch(error => {
        logInit('error', 'Failed to fetch table', {
          tableId,
          error: error instanceof Error ? error.message : String(error),
        })
        if (!cancelled) setFetchFailed(true)
      })
      .finally(() => {
        if (!cancelled && tableLoadRef.current === tableId) {
          tableLoadRef.current = null
        }
      })
    return () => { cancelled = true }
  }, [tableId, table, isActive, getGlobalTable])

  // ── Step 2: tableId 变化时重置状态 ──
  useEffect(() => {
    if (initializedRef.current.tableId !== tableId) {
      initEpochRef.current += 1
      initializedRef.current = {
        tableId,
        viewInitialized: false,
        viewInitializing: false,
      }
      initAttemptedRef.current = false
      tableRef.current = null
      tableRefreshRef.current = null
      setViewInitFailed(false)
      setFetchFailed(false)
      logInit('debug', 'tableId changed, reset init latch', {
        tableId,
        epoch: initEpochRef.current,
      })
    }
  }, [tableId])

  // ── Step 3: 注入本地 tableStore ──
  const onTableReadyRef = useRef(onTableReady)
  onTableReadyRef.current = onTableReady

  useEffect(() => {
    if (!table) return
    if (selectedTableForCurrent) {
      const resolvedTable = pickFresherTableMetadata(selectedTableForCurrent, table)
      if (tableMetadataNeedsResync(selectedTableForCurrent, table)
        && resolvedTable !== selectedTableForCurrent) {
        selectTable(resolvedTable, { force: true })
      }
      onTableReadyRef.current?.(tableId, resolvedTable)
      return
    }
    selectTable(table)
    onTableReadyRef.current?.(tableId, table)
  }, [selectTable, selectedTableForCurrent, table, tableId])

  const tableForInit = selectedTableForCurrent ?? table

  // ── 派生状态（提前算 isViewReady，供 Step 4/5 使用）──
  // per-tab 与 global 不一致时，按 updated_at 取较新的一份（本地改名 vs 服务端详情刷新均覆盖）。
  const displayTable = selectedTableForCurrent && table
    ? pickFresherTableMetadata(selectedTableForCurrent, table)
    : (selectedTableForCurrent ?? (tableRef.current || table))
  const isTableReady = Boolean(displayTable)
  const isViewReady = viewTableId === tableId && Boolean(currentViewId)

  // ── Step 4: 初始化 ViewStore（防并发，仅活跃标签页） ──
  useEffect(() => {
    if (!isActive) {
      // parked：废弃进行中的初始化，释放门闩；不在此自动重试，等再次 active
      if (initializedRef.current.viewInitializing) {
        const epoch = ++initEpochRef.current
        initializedRef.current.viewInitializing = false
        initAttemptedRef.current = false
        setIsLoading(false)
        setViewInitFailed(false)
        logInit('debug', 'parked: abandon in-flight initialize', {
          tableId,
          epoch,
          viewInitialized: initializedRef.current.viewInitialized,
        })
      }
      return
    }
    if (initializedRef.current.viewInitialized) return
    if (initializedRef.current.viewInitializing) return
    if (!tableForInit) return

    const epoch = ++initEpochRef.current
    initializedRef.current.viewInitializing = true
    initAttemptedRef.current = true
    setIsLoading(true)
    setViewInitFailed(false)
    tableRef.current = tableForInit

    const currentTableId = tableId
    logInit('debug', 'initialize start', {
      tableId: currentTableId,
      epoch,
      isActive,
    })

    const initView = async () => {
      try {
        await initializeView(tableForInit.id)
        if (epoch !== initEpochRef.current) return
        if (initializedRef.current.tableId !== currentTableId) return
        logInit('debug', 'initialize resolved', {
          tableId: currentTableId,
          epoch,
        })
      } catch (error) {
        logInit('error', 'Failed to initialize view', {
          tableId: currentTableId,
          epoch,
          error: error instanceof Error ? error.message : String(error),
        })
        if (epoch !== initEpochRef.current) return
        if (initializedRef.current.tableId !== currentTableId) return
        // 失败不标 viewInitialized，保留「正在准备 + 重新加载」。
        setViewInitFailed(true)
      } finally {
        if (epoch !== initEpochRef.current) return
        if (initializedRef.current.tableId !== currentTableId) return
        initializedRef.current.viewInitializing = false
        setIsLoading(false)
      }
    }

    void initView()
    // 刻意不把 isViewReady / currentViewId 放进依赖，避免 !ready 循环打爆请求。
    // 重新启动只靠：active 边沿、tableId 变化、或用户 retry。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId, tableForInit?.id, isActive])

  // ── Step 5: 以 currentViewId 就绪为唯一成功信号（不等待首屏 records）──
  useEffect(() => {
    if (!isViewReady) {
      if (initializedRef.current.viewInitialized) {
        initializedRef.current.viewInitialized = false
        logInit('warn', 'isViewReady lost, clear sticky success', {
          tableId,
          viewTableId,
          currentViewId,
          epoch: initEpochRef.current,
        })
      }
      return
    }
    initializedRef.current.viewInitialized = true
    initializedRef.current.viewInitializing = false
    setIsLoading(false)
    setViewInitFailed(false)
    logInit('debug', 'view ready', {
      tableId,
      viewTableId,
      currentViewId,
      epoch: initEpochRef.current,
    })
  }, [isViewReady, tableId, viewTableId, currentViewId])

  // initialize 已结束但仍无 currentViewId → 可恢复失败（避免门闩释放后 effect 不再触发而永久卡住）。
  // 短延迟避开 zustand 已写入、React props 尚未提交的竞态，防止成功路径误闪重试态。
  useEffect(() => {
    if (!isActive || isViewReady) return
    if (initializedRef.current.viewInitializing || isLoading) return
    if (!initAttemptedRef.current || viewInitFailed) return
    const timer = setTimeout(() => {
      if (
        !initAttemptedRef.current
        || initializedRef.current.viewInitializing
        || initializedRef.current.viewInitialized
      ) {
        return
      }
      setViewInitFailed(true)
      logInit('warn', 'initialize finished without currentViewId', {
        tableId,
        viewTableId,
        currentViewId,
        epoch: initEpochRef.current,
      })
    }, 50)
    return () => clearTimeout(timer)
  }, [isActive, isViewReady, isLoading, viewInitFailed, tableId, viewTableId, currentViewId])

  // 首屏记录拉取在 ViewStore.loadViews 内 await，但 currentViewId 会在 records 返回前写入。
  // 全屏 loading 只等到「表元数据 + 当前视图 id」就绪；记录 loading 由 ViewContainer 承接。
  // 否则慢/挂起的 fetchViewRecords 会让用户一直停在「正在准备表格内容」，点「重新加载」才进表。
  const showPaneLoading = !isTableReady || !isViewReady

  // ── 加载超时兜底（仅可见 active tab；parked root 不累积「重新加载」假现场）──
  const [loadingTimedOut, setLoadingTimedOut] = useState(false)
  useEffect(() => {
    if (!showPaneLoading || !isActive) {
      setLoadingTimedOut(false)
      return
    }
    const timer = setTimeout(() => setLoadingTimedOut(true), LOADING_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [showPaneLoading, isActive])

  // ── 强制重试 ──
  const handleForceRetry = useCallback(() => {
    const epoch = ++initEpochRef.current
    setLoadingTimedOut(false)
    setFetchFailed(false)
    setViewInitFailed(false)
    initializedRef.current = {
      tableId,
      viewInitialized: false,
      viewInitializing: false,
    }
    initAttemptedRef.current = true
    tableRef.current = null
    tableLoadRef.current = null
    tableRefreshRef.current = null
    setIsLoading(true)
    logInit('debug', 'force retry', { tableId, epoch })

    const doRetry = async () => {
      try {
        const freshTable = await getGlobalTable(tableId)
        const retryTable = (freshTable as Table | null) ?? selectedTableForCurrent ?? table
        if (retryTable) {
          await initializeView(retryTable.id)
        } else if (epoch === initEpochRef.current) {
          setFetchFailed(true)
        }
      } catch (error) {
        logInit('error', 'Retry failed', {
          tableId,
          epoch,
          error: error instanceof Error ? error.message : String(error),
        })
        if (epoch !== initEpochRef.current) return
        setViewInitFailed(true)
        if (!(selectedTableForCurrent ?? table)) {
          setFetchFailed(true)
        }
      } finally {
        if (epoch === initEpochRef.current && initializedRef.current.tableId === tableId) {
          initializedRef.current.viewInitializing = false
          setIsLoading(false)
        }
      }
    }
    void doRetry()
  }, [tableId, selectedTableForCurrent, table, initializeView, getGlobalTable])

  return {
    displayTable,
    isLoading,
    fetchFailed: fetchFailed || (viewInitFailed && !displayTable),
    showPaneLoading,
    // 视图初始化已明确失败时立刻给出重试，不必再等 3s。
    loadingTimedOut: loadingTimedOut || viewInitFailed,
    handleForceRetry,
  }
}
