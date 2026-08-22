/**
 * Run 终止分类——stream DONE → finalizeDoneEvent 写入 metadata 时使用
 * 。sendMessageAction 再 export 供单测直引。
 */

/** Runtime 硬停 / 预算墙等「非发送失败」的 error_class。 */
const GRACEFUL_TERMINATION_ERROR_CLASSES = new Set([
  'MAX_CREDITS_EXCEEDED',
  'MAX_TURNS_EXCEEDED',
  'iteration_budget_exhausted',
  'token_budget_exhausted',
  'text_loop_terminated',
  'tool_loop_terminated',
])

/**
 * 判定一次 run 的终止是否属于「优雅终止」——即用户消息已成功送达并被处理，
 * 只是运行被主动 / 守卫收尾，**不能**标成「发送失败」。
 *
 * - `isAborted`：用户主动停止 / 插队（errorClass=ABORT 或兜底文案含 abort）。
 * - `isGracefulTermination`：`isAborted` ∪ 运行级预算守卫 ∪ 文本/工具硬停
 *   。用户气泡标 sent；助手侧由 errorClassMap 渲染
 *   「已中止 / 已自动停止」卡。
 */
export function classifyRunTermination(
  effectiveErrorClass: string | undefined,
  doneErrorMessage: string | undefined,
): { isAborted: boolean; isGracefulTermination: boolean } {
  const isAborted = effectiveErrorClass === 'ABORT'
    || !!(doneErrorMessage && /abort/i.test(doneErrorMessage))
  const isGuardOrHardStop = !!effectiveErrorClass
    && GRACEFUL_TERMINATION_ERROR_CLASSES.has(effectiveErrorClass)
  return { isAborted, isGracefulTermination: isAborted || isGuardOrHardStop }
}
