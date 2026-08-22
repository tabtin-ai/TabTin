/**
 * makeExitGuardRelaunchHook 单测 —— Wave 1 第二轮 Review S-6 修订。
 *
 * 抽出该 hook 的目的就是让"exitGuard.ask 包成 throwable hook"这一段
 * 业务路径可被单测，不再藏在 main-app.ts 的顶级 immediate code 里。
 */

import { describe, expect, it, vi } from 'vitest'
import { makeExitGuardRelaunchHook } from '../exit-guard-relaunch-hook'

describe('makeExitGuardRelaunchHook', () => {
  it('exitGuard.ask 返回 "continue" → hook resolve undefined（继续重启）', async () => {
    const exitGuard = { ask: vi.fn().mockResolvedValue('continue') }
    const hook = makeExitGuardRelaunchHook(exitGuard)
    await expect(hook()).resolves.toBeUndefined()
    expect(exitGuard.ask).toHaveBeenCalledWith('app-relaunch')
  })

  it('exitGuard.ask 返回 "cancel" → hook reject Error（中止重启）', async () => {
    const exitGuard = { ask: vi.fn().mockResolvedValue('cancel') }
    const hook = makeExitGuardRelaunchHook(exitGuard)
    await expect(hook()).rejects.toThrow('relaunch_aborted_by_user')
    expect(exitGuard.ask).toHaveBeenCalledWith('app-relaunch')
  })

  it('exitGuard.ask 返回意外字符串 → 视为 continue（容错降级，不阻塞 LLM）', async () => {
    // 假设未来 ExitGuardChoice 加新值（如 'force-quit'），hook 不该当作 cancel
    // 处理——失败要显式（reject）而不是隐式吞掉。当前默认 '其他值 = continue'
    // 是符合"宁可重启时丢一份未保存（用户已被弹窗提示），不要让 LLM 拿不到结果
    // 反复试"的取舍。
    const exitGuard = { ask: vi.fn().mockResolvedValue('something-else') }
    const hook = makeExitGuardRelaunchHook(exitGuard)
    await expect(hook()).resolves.toBeUndefined()
  })

  it('exitGuard.ask 抛错 → hook 抛同一错误（让上层 LLM 看到，便于排错）', async () => {
    // 典型场景：renderer 进程崩溃 / IPC channel 断开 → exitGuard.ask reject
    // 或 throw —— 此时 hook 不该静默吞掉（如果静默 resolve，relaunch 会照样跑，
    // 用户的 dirty 数据全丢；如果静默 reject 通用 message，LLM 拿到的 status:'aborted'
    // 缺乏排错线索）。让原错误透传，由上层 system-tools.execute 的 catch 块统一
    // 包装成 ToolResult。
    const boom = new Error('renderer-not-responding')
    const exitGuard = { ask: vi.fn().mockRejectedValue(boom) }
    const hook = makeExitGuardRelaunchHook(exitGuard)
    await expect(hook()).rejects.toBe(boom)
  })
})
