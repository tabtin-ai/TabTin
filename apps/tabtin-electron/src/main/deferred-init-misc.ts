import { createLogger } from './logger'
import type { SleepGuardDeps } from './system-sleep-guard'

const mainLog = createLogger('Main')

let disposeSleepGuardFn: (() => void) | null = null

export async function initMisc(sleepGuardDeps: SleepGuardDeps): Promise<void> {
  const { installSystemSleepGuard } = await import('./system-sleep-guard')

  disposeSleepGuardFn = installSystemSleepGuard(sleepGuardDeps)
  mainLog.info('Misc 初始化完成')
}

export function disposeSleepGuardSync(): void {
  try {
    disposeSleepGuardFn?.()
    disposeSleepGuardFn = null
  } catch {
    // ignore
  }
}
