/**
 * 页面级共享 rAF：所有 AgentOrb 实例挂到同一条循环上，避免 N 个球开 N 条调度。
 * 无实例时自动停表，不空转。
 */

export interface OrbFrameDriver {
  onFrame: (dtSeconds: number, nowMs: number) => void
}

const drivers = new Set<OrbFrameDriver>()
let rafId: number | null = null
let lastNowMs = 0

function tick(nowMs: number): void {
  const rawDt = (nowMs - lastNowMs) / 1000
  // 与 lifecycle 的 dt 上限对齐；首帧 lastNowMs 刚设成 now 时 dt≈0，无害
  const dtSeconds = Math.min(0.05, Math.max(0, rawDt))
  lastNowMs = nowMs
  for (const driver of drivers) {
    driver.onFrame(dtSeconds, nowMs)
  }
  if (drivers.size > 0) {
    rafId = requestAnimationFrame(tick)
  } else {
    rafId = null
  }
}

export function registerOrbDriver(driver: OrbFrameDriver): () => void {
  drivers.add(driver)
  if (rafId == null) {
    lastNowMs = performance.now()
    rafId = requestAnimationFrame(tick)
  }
  return () => {
    drivers.delete(driver)
    if (drivers.size === 0 && rafId != null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }
}

/** 仅供单测断言卸载清理；产品代码勿依赖。 */
export function getOrbDriverCountForTests(): number {
  return drivers.size
}
