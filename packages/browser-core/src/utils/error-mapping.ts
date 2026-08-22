import { ToolErrorCode } from '../types/errors';

let _messagePatterns: ReadonlyArray<[RegExp, ToolErrorCode]> | undefined;

function getMessagePatterns(): ReadonlyArray<[RegExp, ToolErrorCode]> {
  return (_messagePatterns ??= [
    [/\b429\b|rate\s*limit|too\s+many\s+requests|频率限制|请求过多/, ToolErrorCode.RATE_LIMITED],
    [/\b403\b|\bblocked\b(?!\s+by)|(?:been|is|got)\s+blocked|forbidden|access\s+denied|被封禁|被阻断|访问被拒绝/, ToolErrorCode.BLOCKED],
    [/timeout|超时/, ToolErrorCode.TIMEOUT],
    [/page\s+not\s+found|\b404\b/, ToolErrorCode.PAGE_NOT_FOUND],
    [/run\s+not\s+found|未找到.*run/, ToolErrorCode.RUN_NOT_FOUND],
    [/tab\s+not\s+found|view\s+not\s+found|没有可用视图|没有视图/, ToolErrorCode.TAB_NOT_FOUND],
    [/element.*not\s+found|元素.*未找到/, ToolErrorCode.ELEMENT_NOT_FOUND],
    [/not\s+visible|不可见/, ToolErrorCode.ELEMENT_NOT_VISIBLE],
    [/not\s+interactable|不可点击|不可交互/, ToolErrorCode.ELEMENT_NOT_INTERACTABLE],
    [/selector.*invalid|invalid.*selector|选择器/, ToolErrorCode.INVALID_SELECTOR],
    [/navigation|导航/, ToolErrorCode.NAVIGATION_FAILED],
    [/captcha/, ToolErrorCode.CAPTCHA_REQUIRED],
    [/\bnetwork\b/, ToolErrorCode.NETWORK_ERROR],
    [/\bcrashed\b|崩溃|(?:destroyed|killed).*?(?:webcontents|view|page|render|process)|(?:webcontents|view|page|render|process).*?(?:destroyed|killed)/, ToolErrorCode.PAGE_CRASHED],
  ]);
}

/**
 * 将字符串/消息映射为标准 ToolErrorCode。
 *
 * 与 @tabtin/action-tools utils/error.ts 逻辑保持一致。
 */
export function mapToToolErrorCode(code?: string, message?: string): ToolErrorCode {
  const normalized = (code || '').toLowerCase();
  if (normalized.includes('blocked')) return ToolErrorCode.BLOCKED;
  if (normalized.includes('rate_limited')) return ToolErrorCode.RATE_LIMITED;
  if (normalized.includes('timeout')) return ToolErrorCode.TIMEOUT;
  if (normalized.includes('ref_semantic_relocate_failed')) return ToolErrorCode.REF_SEMANTIC_RELOCATE_FAILED;
  if (normalized.includes('element_not_found')) return ToolErrorCode.ELEMENT_NOT_FOUND;
  if (normalized.includes('element_not_visible')) return ToolErrorCode.ELEMENT_NOT_VISIBLE;
  if (normalized.includes('element_not_interactable')) return ToolErrorCode.ELEMENT_NOT_INTERACTABLE;
  if (normalized.includes('invalid_selector')) return ToolErrorCode.INVALID_SELECTOR;
  if (normalized.includes('selector_evaluation_failed')) return ToolErrorCode.SELECTOR_EVALUATION_FAILED;
  if (normalized.includes('navigation')) return ToolErrorCode.NAVIGATION_FAILED;
  if (normalized.includes('captcha')) return ToolErrorCode.CAPTCHA_REQUIRED;
  if (normalized.includes('page_not_loaded')) return ToolErrorCode.PAGE_NOT_LOADED;
  if (normalized.includes('unsupported_operation')) return ToolErrorCode.UNSUPPORTED_OPERATION;
  if (normalized.includes('ipc_not_available')) return ToolErrorCode.IPC_NOT_AVAILABLE;
  if (normalized.includes('invalid_parameter')) return ToolErrorCode.INVALID_PARAMETER;
  if (normalized.includes('run_not_found')) return ToolErrorCode.RUN_NOT_FOUND;
  if (normalized.includes('tab_not_found')) return ToolErrorCode.TAB_NOT_FOUND;
  if (normalized.includes('session_not_found')) return ToolErrorCode.SESSION_NOT_FOUND;
  if (normalized.includes('session_busy')) return ToolErrorCode.SESSION_BUSY;
  if (normalized.includes('permission_denied')) return ToolErrorCode.PERMISSION_DENIED;
  if (normalized.includes('invalid_param')) return ToolErrorCode.INVALID_PARAMETER;
  if (normalized.includes('policy_blocked')) return ToolErrorCode.POLICY_BLOCKED;
  if (normalized.includes('session_limit_reached')) return ToolErrorCode.SESSION_LIMIT_REACHED;
  if (normalized.includes('page_crashed')) return ToolErrorCode.PAGE_CRASHED;

  const msg = (message || '').toLowerCase();
  for (const [pattern, errorCode] of getMessagePatterns()) {
    if (pattern.test(msg)) return errorCode;
  }

  return ToolErrorCode.UNKNOWN_ERROR;
}
