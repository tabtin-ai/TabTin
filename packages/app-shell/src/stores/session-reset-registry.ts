/**
 * sessionResetRegistry — 会话重置注册表
 *
 * Phase 执行顺序：teardown → reset → cleanup
 */

import { createLogger } from '../utils/logger.js'

const log = createLogger('SessionReset')

export type ResetPhase = 'teardown' | 'reset' | 'cleanup'

interface ResetAction {
  name: string
  phase: ResetPhase
  run: () => void | Promise<void>
}

const actions: ResetAction[] = []
const registered = new Set<string>()

export function registerResetAction(
  name: string,
  phase: ResetPhase,
  run: () => void | Promise<void>,
): void {
  if (registered.has(name)) {
    const idx = actions.findIndex(a => a.name === name)
    if (idx !== -1) actions[idx] = { name, phase, run }
    return
  }
  registered.add(name)
  actions.push({ name, phase, run })
}

const PHASE_ORDER: ResetPhase[] = ['teardown', 'reset', 'cleanup']

export async function runAllResetActions(): Promise<void> {
  // 登出 / 会话重置是关键生命周期切换：诊断包据此还原「登出时哪些子系统清理失败」
  log.info('Session reset started:', { phases: PHASE_ORDER, actionCount: actions.length })
  for (const phase of PHASE_ORDER) {
    for (const action of actions.filter(a => a.phase === phase)) {
      try {
        await action.run()
      } catch (error) {
        log.error(`reset action failed:`, { action: action.name, phase, error })
      }
    }
  }
  log.info('Session reset completed')
}
