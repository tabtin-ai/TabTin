import { describe, expect, it } from 'vitest'
import {
  getBackgroundSeverity,
  getBrowserSeverity,
  getOverviewSeverity,
  getTabDataRuntimeSeverity,
  getTabDocRuntimeSeverity,
} from './severity'

describe('resource-monitor severity', () => {
  it('在总账 CPU 或内存占比过高时进入高压', () => {
    expect(getOverviewSeverity({ ramSharePercent: 8, totalCpu: 196, cpuCoreCount: 4, totalMemoryBytes: 500 * 1024 * 1024 }).level).toBe('heavy')
    expect(getOverviewSeverity({ ramSharePercent: 12, totalCpu: 60, cpuCoreCount: 8, totalMemoryBytes: 500 * 1024 * 1024 }).level).toBe('attention')
  })

  it('在绝对内存超过阈值时触发高压，无论占比', () => {
    expect(getOverviewSeverity({ ramSharePercent: 3, totalCpu: 10, cpuCoreCount: 8, totalMemoryBytes: 4.5 * 1024 * 1024 * 1024 }).level).toBe('heavy')
    expect(getOverviewSeverity({ ramSharePercent: 3, totalCpu: 10, cpuCoreCount: 8, totalMemoryBytes: 2.8 * 1024 * 1024 * 1024 }).level).toBe('attention')
  })

  it('CPU 阈值按核心数归一化', () => {
    // 80/8 = 10% 单核 < 12% → healthy
    expect(getOverviewSeverity({ ramSharePercent: 3, totalCpu: 80, cpuCoreCount: 8, totalMemoryBytes: 500 * 1024 * 1024 }).level).toBe('healthy')
    // 200/4 = 50% 单核 >= 25% → heavy
    expect(getOverviewSeverity({ ramSharePercent: 3, totalCpu: 200, cpuCoreCount: 4, totalMemoryBytes: 500 * 1024 * 1024 }).level).toBe('heavy')
    // 200/8 = 25% 单核 >= 25% → heavy（边界值）
    expect(getOverviewSeverity({ ramSharePercent: 3, totalCpu: 200, cpuCoreCount: 8, totalMemoryBytes: 500 * 1024 * 1024 }).level).toBe('heavy')
    // 100/8 = 12.5% 单核 >= 12% → attention
    expect(getOverviewSeverity({ ramSharePercent: 3, totalCpu: 100, cpuCoreCount: 8, totalMemoryBytes: 500 * 1024 * 1024 }).level).toBe('attention')
  })

  it('为后台与宿主开销生成独立 severity', () => {
    expect(getBackgroundSeverity({
      unassignedMemory: 300,
      rendererResidualMemory: 480,
      hostOverheadMemory: 420,
      totalMemory: 2000,
      totalCpu: 80,
    }).level).toBe('heavy')

    expect(getBackgroundSeverity({
      unassignedMemory: 180,
      rendererResidualMemory: 120,
      hostOverheadMemory: 380,
      totalMemory: 2000,
      totalCpu: 50,
    }).level).toBe('attention')
  })

  it('为 Browser 解释层生成独立 severity', () => {
    expect(getBrowserSeverity({
      browserMemorySharePercent: 52,
      totalCpu: 30,
      reclaimableViewCount: 0,
      loadingViewCount: 1,
      unassignedViewCount: 0,
    }).level).toBe('heavy')

    expect(getBrowserSeverity({
      browserMemorySharePercent: 18,
      totalCpu: 18,
      reclaimableViewCount: 1,
      loadingViewCount: 0,
      unassignedViewCount: 0,
    }).level).toBe('attention')
  })

  it('统一 TabData / TabDoc 的解释性 severity', () => {
    expect(getTabDataRuntimeSeverity({
      errorRatePct: 15,
      scrollFpsP95: 20,
      inputLatencyP95: 680,
      gridLoading: false,
      isRecordsLoading: false,
      isRecordLoading: false,
    }).level).toBe('heavy')

    expect(getTabDocRuntimeSeverity({
      saveState: 'error',
    }).level).toBe('heavy')
  })
})
