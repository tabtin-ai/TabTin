import { ToolErrorCode } from '../types/errors'

/**
 * 将字符串/消息映射为标准 ToolErrorCode，便于各工具统一处理。
 *
 * 2026-05-10 R1 复核第二轮（W1-LL-8/9 fix-of-fix）：
 *   函数原本只 cover browser 工具用的若干 code（element_not_found / blocked /
 *   timeout 等），任何不在列表里的 valid enum value 会被压成 message phrase
 *   兜底命中的某个 code（例如 fileEditTool 设的 `'old_string_not_found'` 因
 *   message 含 'not found' 字面量被 mangle 成 ELEMENT_NOT_FOUND），让上游"显式
 *   set error_code 防 phrase 漂移"的设计目标在生产链路下永远不命中。
 *
 *   修法：在所有 phrase 检测之前加一层 SSoT short-circuit——任何已注册的
 *   ToolErrorCode value 直接透传。这样未来加新 code（OLD_STRING_NOT_FOUND /
 *   OLD_STRING_NOT_UNIQUE / 任何后续）都不需要更新本函数，避免漂移。
 */
const TOOL_ERROR_CODE_VALUES: Set<string> = new Set(Object.values(ToolErrorCode))

export function mapToToolErrorCode(code?: string, message?: string): ToolErrorCode {
  const normalized = (code || '').toLowerCase()

  // SSoT short-circuit：valid ToolErrorCode value 直接透传，不进 phrase 检测。
  // 防止生产链路把"显式 set 的精确 code"压成"phrase 兜底命中的近似 code"。
  if (normalized && TOOL_ERROR_CODE_VALUES.has(normalized)) {
    return normalized as ToolErrorCode
  }

  if (normalized.includes('blocked')) return ToolErrorCode.BLOCKED
  if (normalized.includes('rate_limited')) return ToolErrorCode.RATE_LIMITED
  if (normalized.includes('timeout')) return ToolErrorCode.TIMEOUT
  if (normalized.includes('element_not_found')) return ToolErrorCode.ELEMENT_NOT_FOUND
  if (normalized.includes('element_not_visible')) return ToolErrorCode.ELEMENT_NOT_VISIBLE
  if (normalized.includes('element_not_interactable')) return ToolErrorCode.ELEMENT_NOT_INTERACTABLE
  if (normalized.includes('invalid_selector')) return ToolErrorCode.INVALID_SELECTOR
  if (normalized.includes('selector_evaluation_failed')) return ToolErrorCode.SELECTOR_EVALUATION_FAILED
  if (normalized.includes('navigation')) return ToolErrorCode.NAVIGATION_FAILED
  if (normalized.includes('captcha')) return ToolErrorCode.CAPTCHA_REQUIRED
  if (normalized.includes('page_not_loaded')) return ToolErrorCode.PAGE_NOT_LOADED
  if (normalized.includes('unsupported_operation')) return ToolErrorCode.UNSUPPORTED_OPERATION
  if (normalized.includes('ipc_not_available')) return ToolErrorCode.IPC_NOT_AVAILABLE
  if (normalized.includes('invalid_parameter')) return ToolErrorCode.INVALID_PARAMETER
  if (normalized.includes('run_not_found')) return ToolErrorCode.RUN_NOT_FOUND
  if (normalized.includes('tab_not_found')) return ToolErrorCode.TAB_NOT_FOUND
  if (normalized.includes('session_not_found')) return ToolErrorCode.SESSION_NOT_FOUND
  if (normalized.includes('session_busy')) return ToolErrorCode.SESSION_BUSY
  if (normalized.includes('policy_blocked')) return ToolErrorCode.POLICY_BLOCKED
  if (normalized.includes('session_limit_reached')) return ToolErrorCode.SESSION_LIMIT_REACHED
  if (normalized.includes('page_crashed')) return ToolErrorCode.PAGE_CRASHED

  const msg = (message || '').toLowerCase()
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) return ToolErrorCode.RATE_LIMITED
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('access denied') || msg.includes('you have been blocked')) return ToolErrorCode.BLOCKED
  if (msg.includes('timeout')) return ToolErrorCode.TIMEOUT
  if (msg.includes('not found')) return ToolErrorCode.ELEMENT_NOT_FOUND
  if (msg.includes('not visible')) return ToolErrorCode.ELEMENT_NOT_VISIBLE
  if (msg.includes('not interactable')) return ToolErrorCode.ELEMENT_NOT_INTERACTABLE
  if (msg.includes('selector')) return ToolErrorCode.INVALID_SELECTOR
  if (msg.includes('navigation')) return ToolErrorCode.NAVIGATION_FAILED
  if (msg.includes('run not found')) return ToolErrorCode.RUN_NOT_FOUND
  if (msg.includes('tab not found') || msg.includes('view not found')) return ToolErrorCode.TAB_NOT_FOUND
  if (msg.includes('超时')) return ToolErrorCode.TIMEOUT
  if (msg.includes('频率限制') || msg.includes('请求过多')) return ToolErrorCode.RATE_LIMITED
  if (msg.includes('被封禁') || msg.includes('被阻断') || msg.includes('访问被拒绝')) return ToolErrorCode.BLOCKED
  if (msg.includes('未找到') && msg.includes('run')) return ToolErrorCode.RUN_NOT_FOUND
  if (msg.includes('没有可用视图') || msg.includes('没有视图')) return ToolErrorCode.TAB_NOT_FOUND
  if (msg.includes('元素') && msg.includes('未找到')) return ToolErrorCode.ELEMENT_NOT_FOUND
  if (msg.includes('不可见')) return ToolErrorCode.ELEMENT_NOT_VISIBLE
  if (msg.includes('不可点击') || msg.includes('不可交互')) return ToolErrorCode.ELEMENT_NOT_INTERACTABLE
  if (msg.includes('选择器')) return ToolErrorCode.INVALID_SELECTOR
  if (msg.includes('导航')) return ToolErrorCode.NAVIGATION_FAILED
  if (msg.includes('crashed') || msg.includes('崩溃') ||
      (msg.includes('destroyed') && (msg.includes('webcontents') || msg.includes('view') || msg.includes('page') || msg.includes('render'))) ||
      (msg.includes('killed') && (msg.includes('render') || msg.includes('process')))) return ToolErrorCode.PAGE_CRASHED

  return ToolErrorCode.UNKNOWN_ERROR
}
