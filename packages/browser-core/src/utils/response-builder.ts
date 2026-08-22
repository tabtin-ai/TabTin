/**
 * ResponseBuilder — 统一的工具响应构建与序列化
 *
 * 提供 buildToolError / safeSerialize / buildStopOnErrorResult 等辅助函数，
 * 消除 BrowserToolImpl 中的重复模式。
 */

import { ToolErrorCode, ToolErrorFactory, type ToolError } from '../types/errors';
import { mapToToolErrorCode } from './error-mapping';
import type { ExecuteActOutput } from '../types/browser';

export function buildToolError(
  message: string,
  code?: ToolErrorCode,
  context?: Record<string, any>,
): ToolError {
  return ToolErrorFactory.fatal(code ?? mapToToolErrorCode(undefined, message), message, context);
}

/**
 * @deprecated 通过 fallbackContext.webContents 直接操作 WebContents 绕过了 BrowserContext 抽象。
 * 后续应改为接收 BrowserContext 实例以保持环境无关。
 */
export function safeSerialize<T>(
  response: T,
  fallbackContext: { elapsedMs: number; tabId: string; webContents?: any },
): T {
  try {
    return JSON.parse(JSON.stringify(response));
  } catch (serializeError) {
    console.error(`[ResponseBuilder] ❌ 响应序列化失败:`, serializeError);
    const fallback: any = {
      success: false,
      executed_actions: [],
      frontend_execution_time_ms: fallbackContext.elapsedMs,
      page_url: fallbackContext.webContents?.getURL?.() ?? '',
      page_title: fallbackContext.webContents?.getTitle?.() ?? '',
      error: buildToolError(
        'Internal error: Response serialization failed',
        ToolErrorCode.UNKNOWN_ERROR,
        { viewId: fallbackContext.tabId },
      ),
    };
    return fallback as T;
  }
}

/**
 * @deprecated 直接接收 webContents: any 绕过了 BrowserContext 抽象。
 * 后续应改为接收 BrowserContext 实例以保持环境无关。
 */
export function buildStopOnErrorResult(
  executedActions: any[],
  webContents: any,
  startTime: number,
  tabId: string,
  actionType: string,
  failureEntry: any,
): ExecuteActOutput {
  console.log(`[ResponseBuilder] ⚠️  stop_on_error=true，提前返回`);
  const endTime = Date.now();
  const errorCode = failureEntry.error_code || mapToToolErrorCode(undefined, failureEntry.error);
  const response: any = {
    success: false,
    executed_actions: executedActions,
    frontend_execution_time_ms: endTime - startTime,
    page_url: webContents.getURL(),
    page_title: webContents.getTitle(),
    error: buildToolError(failureEntry.error, errorCode, { viewId: tabId, action: actionType }),
  };
  if (failureEntry.error_code) response.error_code = failureEntry.error_code;

  return safeSerialize(response, { elapsedMs: endTime - startTime, tabId, webContents });
}

export function buildTabMissingResult(
  runId: string,
  startTime: number,
): ExecuteActOutput {
  return {
    success: false,
    executed_actions: [],
    frontend_execution_time_ms: Date.now() - startTime,
    page_url: '',
    page_title: '',
    error: buildToolError('No available browser view for run', ToolErrorCode.PAGE_NOT_LOADED, { runId }),
  };
}

export function buildTopLevelErrorResult(
  error: unknown,
  startTime: number,
  context?: { runId?: string; viewId?: string },
): ExecuteActOutput {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = mapToToolErrorCode(undefined, errorMessage);
  return {
    success: false,
    executed_actions: [],
    frontend_execution_time_ms: Date.now() - startTime,
    page_url: '',
    page_title: '',
    error: buildToolError(errorMessage, errorCode, context),
  };
}
