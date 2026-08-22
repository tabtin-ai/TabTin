/**
 * 统一错误类型定义（现阶段 Single Source of Truth）
 *
 * action-tools 通过 re-export 引用本文件，请勿在 action-tools / contracts 中重复定义。
 * `@tabtin/contracts/tool` 上的死镜像已删除；P2 将改为生成式单源。
 */

import { mapToToolErrorCode } from '../utils/error-mapping';

export enum ToolErrorCode {
  ELEMENT_NOT_FOUND = 'element_not_found',
  TIMEOUT = 'timeout',
  NETWORK_ERROR = 'network_error',
  NAVIGATION_FAILED = 'navigation_failed',
  PAGE_NOT_LOADED = 'page_not_loaded',
  ELEMENT_NOT_VISIBLE = 'element_not_visible',
  ELEMENT_NOT_INTERACTABLE = 'element_not_interactable',
  INVALID_SELECTOR = 'invalid_selector',
  SELECTOR_EVALUATION_FAILED = 'selector_evaluation_failed',
  REF_SEMANTIC_RELOCATE_FAILED = 'ref_semantic_relocate_failed',
  PERMISSION_DENIED = 'permission_denied',
  BLOCKED = 'blocked',
  RATE_LIMITED = 'rate_limited',
  CAPTCHA_REQUIRED = 'captcha_required',
  PAGE_NOT_FOUND = 'page_not_found',
  INVALID_PARAMETER = 'invalid_parameter',
  MISSING_REQUIRED_PARAM = 'missing_required_param',
  UNSUPPORTED_OPERATION = 'unsupported_operation',
  IPC_NOT_AVAILABLE = 'ipc_not_available',
  RUN_NOT_FOUND = 'run_not_found',
  TAB_NOT_FOUND = 'tab_not_found',
  SESSION_NOT_FOUND = 'session_not_found',
  SESSION_BUSY = 'session_busy',
  POLICY_BLOCKED = 'policy_blocked',
  SESSION_LIMIT_REACHED = 'session_limit_reached',
  SESSION_EXITED = 'session_exited',
  PAGE_CRASHED = 'page_crashed',
  CAPABILITY_UNAVAILABLE = 'capability_unavailable',
  // 2026-05-10 R1 (W1-LL-8/9)：tabcode `edit_file` 失败的两类细分错。
  // adapter (read-file-state.ts:mapActionErrorToRuntimeKind) 优先按这两个
  // ToolErrorCode 映射为 runtime error_kind（old_string_not_found /
  // old_string_not_unique）；phrase 检测仅作老版本 / 自创工具的兜底。
  OLD_STRING_NOT_FOUND = 'old_string_not_found',
  OLD_STRING_NOT_UNIQUE = 'old_string_not_unique',
  // 2026-05-13 文件并发安全 Wave 2 / TOCTOU 二次校验：fileEditTool /
  // fileWriteTool 在写盘前最后一刻通过 adapter 注入的 `_validate_before_write`
  // hook 校验 readFileState 跟磁盘 mtime/content 一致性，撞 stale 时统一用本
  // code。adapter 经 bridge / 显式 case 映射为 runtime `tool_stale_read`，
  // 与入口校验 (validateReadBeforeWrite) 字节一致。
  STALE_READ = 'stale_read',
  // W1 file pipeline 显式细分（与 `@tabtin/file-pipeline-errors` SSoT 对齐）。
  // adapter 优先按这个 code 路由到 runtime `file_too_large`，让 25MB 大图等
  // 失败信号在 envelope 里精确呈现"图片过大"而非 generic "unsupported"。
  FILE_TOO_LARGE = 'file_too_large',
  FILE_NOT_FOUND = 'file_not_found',
  UNKNOWN_ERROR = 'unknown_error',
}

export interface ToolError {
  code: ToolErrorCode;
  message: string;
  retriable: boolean;
  fatal: boolean;
  context?: {
    selector?: string;
    timeout?: number;
    url?: string;
    viewId?: string;
    [key: string]: any;
  };
  originalError?: string;
}

export class ToolErrorFactory {
  static retriable(
    code: ToolErrorCode,
    message: string,
    context?: ToolError['context'],
  ): ToolError {
    return { code, message, retriable: true, fatal: false, context };
  }

  static fatal(
    code: ToolErrorCode,
    message: string,
    context?: ToolError['context'],
  ): ToolError {
    return { code, message, retriable: false, fatal: true, context };
  }

  static fromError(error: Error | any, defaultCode = ToolErrorCode.UNKNOWN_ERROR): ToolError {
    const message = error?.message || String(error);
    const rawCode = typeof (error as any)?.code === 'string' ? (error as any).code : undefined;
    const mapped = mapToToolErrorCode(rawCode, message);

    if (mapped !== ToolErrorCode.UNKNOWN_ERROR) {
      return RETRIABLE_CODES.has(mapped)
        ? this.retriable(mapped, message)
        : this.fatal(mapped, message);
    }

    return this.retriable(defaultCode, message, { originalError: String(error) });
  }
}

const RETRIABLE_CODES: ReadonlySet<ToolErrorCode> = new Set([
  ToolErrorCode.ELEMENT_NOT_FOUND,
  ToolErrorCode.REF_SEMANTIC_RELOCATE_FAILED,
  ToolErrorCode.TIMEOUT,
  ToolErrorCode.NETWORK_ERROR,
  ToolErrorCode.NAVIGATION_FAILED,
  ToolErrorCode.PAGE_NOT_LOADED,
  ToolErrorCode.ELEMENT_NOT_VISIBLE,
  ToolErrorCode.ELEMENT_NOT_INTERACTABLE,
  ToolErrorCode.RATE_LIMITED,
]);

export function isRetriableError(error: ToolError | ToolErrorCode): boolean {
  if (typeof error === 'string') return RETRIABLE_CODES.has(error as ToolErrorCode);
  return error.retriable;
}

export function isFatalError(error: ToolError | ToolErrorCode): boolean {
  if (typeof error === 'string') return !isRetriableError(error);
  return error.fatal;
}

export interface StandardToolOutput<T = any> {
  success: boolean;
  data?: T;
  error?: ToolError;
}
