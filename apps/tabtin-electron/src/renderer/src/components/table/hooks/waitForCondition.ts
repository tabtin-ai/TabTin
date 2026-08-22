/**
 * waitForCondition — 有界确定性轮询
 *
 * 用于替代「await 一次副作用 + setTimeout(0)」这类靠单宏任务赌协作/渲染时序的写法：
 * 反复检查 predicate，直到成立或超时。predicate 成立即返回 true，超时返回最后一次
 * predicate 结果。now/sleep 可注入，便于单测在无真实计时器下断言分支。
 */
export interface WaitForConditionOptions {
  /** 最长等待时长（ms）。到点仍未满足则返回最后一次 predicate 结果。默认 2000。 */
  timeoutMs?: number
  /** 相邻两次检查的间隔（ms）。默认 16（约一帧）。 */
  intervalMs?: number
  /** 取当前时间（ms），默认 Date.now，测试可注入虚拟时钟。 */
  now?: () => number
  /** 休眠实现，默认 setTimeout，测试可注入以避免真实等待。 */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForCondition(
  predicate: () => boolean,
  options: WaitForConditionOptions = {},
): Promise<boolean> {
  const {
    timeoutMs = 2000,
    intervalMs = 16,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = options

  if (predicate()) return true
  const start = now()
  while (now() - start < timeoutMs) {
    await sleep(intervalMs)
    if (predicate()) return true
  }
  return predicate()
}
