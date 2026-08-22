export type ResourceMonitorSeverityLevel = 'healthy' | 'attention' | 'heavy'

export interface ResourceMonitorSeverity {
  level: ResourceMonitorSeverityLevel
  label: string
  reason: string
}

interface OverviewSeverityInput {
  ramSharePercent: number
  totalCpu: number
  cpuCoreCount: number
  totalMemoryBytes: number
}

interface BackgroundSeverityInput {
  unassignedMemory: number
  rendererResidualMemory: number
  hostOverheadMemory: number
  totalMemory: number
  totalCpu: number
}

interface BrowserSeverityInput {
  browserMemorySharePercent: number
  totalCpu: number
  reclaimableViewCount: number
  loadingViewCount: number
  unassignedViewCount: number
}

interface TabDataSeverityInput {
  errorRatePct: number
  scrollFpsP95: number | null
  inputLatencyP95: number | null
  gridLoading: boolean
  isRecordsLoading: boolean
  isRecordLoading: boolean
}

interface TabDocSeverityInput {
  saveState: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
}

const clampPositive = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value)
}

const createSeverity = (
  level: ResourceMonitorSeverityLevel,
  label: string,
  reason: string,
): ResourceMonitorSeverity => ({
  level,
  label,
  reason,
})

const toPercent = (value: number): string => `${clampPositive(value).toFixed(1)}%`

const BYTES_PER_GB = 1024 * 1024 * 1024

export const getOverviewSeverity = (
  input: OverviewSeverityInput,
): ResourceMonitorSeverity => {
  const ramSharePercent = clampPositive(input.ramSharePercent)
  const coreCount = Math.max(1, input.cpuCoreCount || 1)
  const perCoreCpu = clampPositive(input.totalCpu) / coreCount
  const totalMemoryGB = clampPositive(input.totalMemoryBytes) / BYTES_PER_GB

  if (ramSharePercent >= 18 || totalMemoryGB >= 4 || perCoreCpu >= 25) {
    if (ramSharePercent >= 18 || totalMemoryGB >= 4) {
      return createSeverity(
        'heavy',
        '满载',
        totalMemoryGB >= 4
          ? `应用内存已达 ${totalMemoryGB.toFixed(1)} GB，总账资源进入高压区间`
          : `整机内存占比 ${toPercent(ramSharePercent)}，总账资源进入高压区间`,
      )
    }
    return createSeverity(
      'heavy',
      '满载',
      `单核平均 CPU ${Math.round(perCoreCpu)}%，活跃任务并发较高`,
    )
  }

  if (ramSharePercent >= 10 || totalMemoryGB >= 2.5 || perCoreCpu >= 12) {
    if (ramSharePercent >= 10 || totalMemoryGB >= 2.5) {
      return createSeverity(
        'attention',
        '良好',
        totalMemoryGB >= 2.5
          ? `应用内存已达 ${totalMemoryGB.toFixed(1)} GB，建议留意后台与多标签并发`
          : `整机内存占比 ${toPercent(ramSharePercent)}，建议留意后台与多标签并发`,
      )
    }
    return createSeverity(
      'attention',
      '良好',
      `单核平均 CPU ${Math.round(perCoreCpu)}%，存在持续负载`,
    )
  }

  return createSeverity('healthy', '松弛', '整体资源占用平稳')
}

export const getBackgroundSeverity = (
  input: BackgroundSeverityInput,
): ResourceMonitorSeverity => {
  const totalMemory = clampPositive(input.totalMemory)
  const unassignedMemory = clampPositive(input.unassignedMemory)
  const rendererResidualMemory = clampPositive(input.rendererResidualMemory)
  const hostOverheadMemory = clampPositive(input.hostOverheadMemory)
  const opaqueMemory = rendererResidualMemory + hostOverheadMemory
  const totalCpu = clampPositive(input.totalCpu)
  const unassignedShare = totalMemory > 0 ? (unassignedMemory / totalMemory) * 100 : 0
  const rendererResidualShare = totalMemory > 0 ? (rendererResidualMemory / totalMemory) * 100 : 0
  const hostOverheadShare = totalMemory > 0 ? (hostOverheadMemory / totalMemory) * 100 : 0
  const opaqueShare = totalMemory > 0 ? (opaqueMemory / totalMemory) * 100 : 0

  if (opaqueShare >= 35 || unassignedShare >= 20 || totalCpu >= 120) {
    if (rendererResidualShare >= 20) {
      return createSeverity(
        'heavy',
        '满载',
        `共享 renderer 残余占总账 ${toPercent(rendererResidualShare)}`,
      )
    }
    if (hostOverheadShare >= 25) {
      return createSeverity(
        'heavy',
        '满载',
        `宿主与其他开销占总账 ${toPercent(hostOverheadShare)}`,
      )
    }
    if (opaqueShare >= 35) {
      return createSeverity(
        'heavy',
        '满载',
        `后台黑盒区占总账 ${toPercent(opaqueShare)}`,
      )
    }
    if (unassignedShare >= 20) {
      return createSeverity(
        'heavy',
        '满载',
        `后台未归因资源占总账 ${toPercent(unassignedShare)}`,
      )
    }
    return createSeverity('heavy', '满载', `后台与宿主 CPU 已达 ${Math.round(totalCpu)}%`)
  }

  if (opaqueShare >= 20 || unassignedShare >= 8 || totalCpu >= 60) {
    if (rendererResidualShare >= 10) {
      return createSeverity(
        'attention',
        '良好',
        `共享 renderer 残余占总账 ${toPercent(rendererResidualShare)}`,
      )
    }
    if (hostOverheadShare >= 15) {
      return createSeverity(
        'attention',
        '良好',
        `宿主与其他开销占总账 ${toPercent(hostOverheadShare)}`,
      )
    }
    if (opaqueShare >= 20) {
      return createSeverity(
        'attention',
        '良好',
        `后台黑盒区占总账 ${toPercent(opaqueShare)}`,
      )
    }
    if (unassignedShare >= 8) {
      return createSeverity(
        'attention',
        '良好',
        `存在 ${toPercent(unassignedShare)} 的后台未归因资源`,
      )
    }
    return createSeverity('attention', '良好', `后台与宿主 CPU 已达 ${Math.round(totalCpu)}%`)
  }

  return createSeverity('healthy', '松弛', '后台与宿主开销平稳')
}

export const getBrowserSeverity = (
  input: BrowserSeverityInput,
): ResourceMonitorSeverity => {
  const browserMemorySharePercent = clampPositive(input.browserMemorySharePercent)
  const totalCpu = clampPositive(input.totalCpu)
  const reclaimableViewCount = clampPositive(input.reclaimableViewCount)
  const loadingViewCount = clampPositive(input.loadingViewCount)
  const unassignedViewCount = clampPositive(input.unassignedViewCount)

  if (
    browserMemorySharePercent >= 45
    || totalCpu >= 80
    || reclaimableViewCount >= 3
    || unassignedViewCount >= 3
  ) {
    if (browserMemorySharePercent >= 45) {
      return createSeverity(
        'heavy',
        '满载',
        `Browser 占总账内存 ${toPercent(browserMemorySharePercent)}`,
      )
    }
    if (reclaimableViewCount >= 3) {
      return createSeverity('heavy', '满载', `存在 ${reclaimableViewCount} 个可回收的 Browser 视图`)
    }
    if (unassignedViewCount >= 3) {
      return createSeverity('heavy', '满载', `存在 ${unassignedViewCount} 个未归属 Space 的 Browser`)
    }
    return createSeverity('heavy', '满载', `Browser CPU 已达 ${Math.round(totalCpu)}%`)
  }

  if (
    browserMemorySharePercent >= 25
    || totalCpu >= 35
    || reclaimableViewCount >= 1
    || loadingViewCount >= 3
    || unassignedViewCount >= 1
  ) {
    if (browserMemorySharePercent >= 25) {
      return createSeverity(
        'attention',
        '良好',
        `Browser 占总账内存 ${toPercent(browserMemorySharePercent)}`,
      )
    }
    if (reclaimableViewCount >= 1) {
      return createSeverity('attention', '良好', `存在 ${reclaimableViewCount} 个可回收的 Browser 视图`)
    }
    if (unassignedViewCount >= 1) {
      return createSeverity('attention', '良好', `存在 ${unassignedViewCount} 个未归属 Space 的 Browser`)
    }
    if (loadingViewCount >= 3) {
      return createSeverity('attention', '良好', `当前有 ${loadingViewCount} 个 Browser 正在加载`)
    }
    return createSeverity('attention', '良好', `Browser CPU 已达 ${Math.round(totalCpu)}%`)
  }

  return createSeverity('healthy', '松弛', 'Browser 视图占用平稳')
}

export const getTabDataRuntimeSeverity = (
  input: TabDataSeverityInput,
): ResourceMonitorSeverity => {
  if (
    clampPositive(input.errorRatePct) >= 12
    || (input.scrollFpsP95 !== null && input.scrollFpsP95 < 24)
    || (input.inputLatencyP95 !== null && input.inputLatencyP95 >= 600)
  ) {
    if (clampPositive(input.errorRatePct) >= 12) {
      return createSeverity('heavy', '满载', `表格交互错误率已达 ${toPercent(input.errorRatePct)}`)
    }
    if (input.scrollFpsP95 !== null && input.scrollFpsP95 < 24) {
      return createSeverity('heavy', '满载', `滚动帧率 P95 仅 ${Math.round(input.scrollFpsP95)} FPS`)
    }
    return createSeverity(
      'heavy',
      '满载',
      `输入延迟 P95 已达 ${Math.round(input.inputLatencyP95 ?? 0)} ms`,
    )
  }

  if (
    input.gridLoading
    || input.isRecordsLoading
    || input.isRecordLoading
    || clampPositive(input.errorRatePct) > 0
    || (input.scrollFpsP95 !== null && input.scrollFpsP95 < 42)
    || (input.inputLatencyP95 !== null && input.inputLatencyP95 >= 240)
  ) {
    if (input.gridLoading || input.isRecordsLoading || input.isRecordLoading) {
      return createSeverity('attention', '良好', '表格仍在加载数据或记录详情')
    }
    if (clampPositive(input.errorRatePct) > 0) {
      return createSeverity('attention', '良好', `表格交互出现 ${toPercent(input.errorRatePct)} 错误率`)
    }
    if (input.scrollFpsP95 !== null && input.scrollFpsP95 < 42) {
      return createSeverity('attention', '良好', `滚动帧率 P95 下降到 ${Math.round(input.scrollFpsP95)} FPS`)
    }
    return createSeverity(
      'attention',
      '良好',
      `输入延迟 P95 为 ${Math.round(input.inputLatencyP95 ?? 0)} ms`,
    )
  }

  return createSeverity('healthy', '松弛', '表格运行态平稳')
}

export const getTabDocRuntimeSeverity = (
  input: TabDocSeverityInput,
): ResourceMonitorSeverity => {
  if (input.saveState === 'error') {
    return createSeverity('heavy', '满载', '文档保存失败，需要用户介入')
  }

  if (input.saveState === 'dirty' || input.saveState === 'saving') {
    return createSeverity('attention', '良好', '文档存在未落盘修改或正在保存')
  }

  return createSeverity('healthy', '松弛', '文档保存状态稳定')
}
