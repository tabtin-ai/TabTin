import { createLogger } from './logger'

const mainLog = createLogger('Main')

export const STEP_TIMEOUT_MS = 3_000

export async function withStepTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | void> {
  return new Promise<T | void>((resolve) => {
    const timer = setTimeout(() => {
      mainLog.warn(`退出清理步骤超时 (${timeoutMs}ms): ${label}`)
      resolve()
    }, timeoutMs)
    fn().then(
      (result) => { clearTimeout(timer); resolve(result) },
      (err) => { clearTimeout(timer); mainLog.warn(`退出清理步骤失败: ${label}`, err); resolve() },
    )
  })
}
