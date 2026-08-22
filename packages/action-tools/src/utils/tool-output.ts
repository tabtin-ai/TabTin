import { ToolErrorCode, ToolErrorFactory, type ToolError } from '../types/errors';
import { mapToToolErrorCode } from './error';

const LEGACY_STRIP_KEYS = new Set([
  'success',
  'data',
  'error',
  'error_message',
  'error_code',
  'errorCode'
]);

function extractData(result: Record<string, any>): Record<string, any> {
  const data: Record<string, any> = {};
  Object.keys(result || {}).forEach((key) => {
    if (!LEGACY_STRIP_KEYS.has(key)) {
      data[key] = result[key];
    }
  });
  return data;
}

function normalizeErrorCode(rawCode?: unknown, message?: string): ToolErrorCode {
  if (typeof rawCode === 'string') {
    const mapped = mapToToolErrorCode(rawCode, message);
    return mapped;
  }
  return ToolErrorCode.UNKNOWN_ERROR;
}

function resolveErrorMessage(result: Record<string, any>): string {
  if (typeof result.error === 'string' && result.error) return result.error;
  if (typeof result.errorCode === 'string' && result.errorCode) return result.errorCode;
  return 'Unknown error';
}

function resolveToolError(
  result: Record<string, any>,
  code: ToolErrorCode,
  context?: Record<string, any>
): ToolError {
  if (result.error && typeof result.error === 'object' && 'code' in result.error && 'message' in result.error) {
    return result.error as ToolError;
  }
  const message = resolveErrorMessage(result);
  return ToolErrorFactory.fatal(code, message, context);
}

export function standardizeLegacyResult<T extends Record<string, any>>(
  result: T,
  options?: {
    context?: Record<string, any>;
    defaultErrorCode?: ToolErrorCode;
    data?: Record<string, any>;
  }
): T & { data?: Record<string, any>; error?: ToolError } {
  if (!result || typeof result !== 'object' || typeof (result as any).success !== 'boolean') {
    const error = ToolErrorFactory.fatal(
      ToolErrorCode.UNKNOWN_ERROR,
      'Invalid tool result',
      options?.context
    );
    return {
      success: false,
      error,
    } as any;
  }

  if ((result as any).success) {
    const data = (result as any).data ?? options?.data ?? extractData(result);
    const { error_message, error_code, errorCode, ...rest } = result as any;
    return {
      ...rest,
      data
    };
  }

  const rawCode = (result as any).error_code ?? (result as any).errorCode;
  const code = options?.defaultErrorCode ?? normalizeErrorCode(rawCode, resolveErrorMessage(result));
  const error = resolveToolError(result, code, options?.context);
  const { error_message, error_code, errorCode, ...rest } = result as any;
  return {
    ...rest,
    error
  };
}
