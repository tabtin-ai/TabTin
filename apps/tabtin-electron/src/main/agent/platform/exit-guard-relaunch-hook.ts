/**
 * 把 exit-guard 的 ask 函数包装成 relaunch_app 工具用的 beforeRelaunch 钩子。
 *
 * 抽出该函数的原因（Wave 1 第二轮 Review）：
 *   - main-app.ts 的顶级 immediate code 不可被单测 import（一 import 就触发
 *     createExitGuardController + dialog 副作用）
 *   - 这一段拼装逻辑（"询问用户 → cancel 时抛错 → continue 时 resolve"）是
 *     Wave 1 第二轮 unsaved 数据保护的核心契约——必须可测
 *   - 抽出后 main-app.ts 仅负责 wiring，逻辑收敛在本文件
 *
 * 契约（与 system-tools.ts 的 beforeRelaunch 钩子约定一致）：
 *   - resolve undefined → relaunch_app 继续 fire-and-forget app.relaunch()
 *   - reject(Error) → relaunch_app 返回 status:'aborted'，LLM 把消息讲给用户
 *
 * 用法：
 * ```ts
 * import { setAppBeforeRelaunch } from './agent/platform/app-relaunch-registry'
 * import { makeExitGuardRelaunchHook } from './agent/platform/exit-guard-relaunch-hook'
 *
 * setAppBeforeRelaunch(makeExitGuardRelaunchHook(exitGuard))
 * ```
 */

export interface ExitGuardLike {
  /**
   * 询问 renderer 是否可以继续退出/重启。reason 决定弹什么对话框：
   *   - `'app-relaunch'` 走"重启前确认未保存改动"对话框（M-3 修订）
   *   - `'app-quit'` 走"退出前确认未保存改动"对话框
   *
   * 返回 'continue' / 'cancel' / 任意其他值。其他值视为 continue（容错）。
   */
  ask: (reason: 'app-quit' | 'window-close' | 'app-relaunch') => Promise<string>
}

export function makeExitGuardRelaunchHook(
  exitGuard: ExitGuardLike,
): () => Promise<void> {
  return async () => {
    const choice = await exitGuard.ask('app-relaunch')
    if (choice === 'cancel') {
      // 抛错让 relaunch_app 工具捕获并返回 status: 'aborted'。
      // message 会被 system-tools.ts 的 catch 块写到 toolResult content，
      // LLM 把它讲给用户后不会硬重启。
      throw new Error('relaunch_aborted_by_user')
    }
    // 其他值（含 'continue' 与意外值）→ resolve undefined → 进入 relaunch
  }
}
