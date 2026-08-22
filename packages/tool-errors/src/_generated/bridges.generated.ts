/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/tool-errors/codegen/bridges.yaml
 * Codegen: pnpm --filter @tabtin/tool-errors codegen
 *
 * browser-core / action-tools string codes → runtime error_kind.
 * Does not mutate producers; network_error and network_failed stay distinct.
 */

export type BridgedBrowserErrorCode =
  | 'network_error'
  | 'invalid_parameter'
  | 'timeout'
  | 'stale_read'
  | 'missing_required_param'
  | 'permission_denied'
  | 'rate_limited'
  | 'old_string_not_found'
  | 'old_string_not_unique'
  | 'file_too_large'
  | 'file_not_found';

export type BridgedRuntimeErrorKind =
  | 'network_failed'
  | 'invalid_param_format'
  | 'request_timeout'
  | 'tool_stale_read'
  | 'missing_required_param'
  | 'permission_denied'
  | 'rate_limited'
  | 'old_string_not_found'
  | 'old_string_not_unique'
  | 'file_too_large'
  | 'file_not_found';

export const BROWSER_TO_RUNTIME_ERROR_KIND: Readonly<
  Record<BridgedBrowserErrorCode, BridgedRuntimeErrorKind>
> = {
  'network_error': 'network_failed',
  'invalid_parameter': 'invalid_param_format',
  'timeout': 'request_timeout',
  'stale_read': 'tool_stale_read',
  'missing_required_param': 'missing_required_param',
  'permission_denied': 'permission_denied',
  'rate_limited': 'rate_limited',
  'old_string_not_found': 'old_string_not_found',
  'old_string_not_unique': 'old_string_not_unique',
  'file_too_large': 'file_too_large',
  'file_not_found': 'file_not_found',
};

export function bridgeBrowserErrorCodeToRuntimeKind(
  code: string,
): BridgedRuntimeErrorKind | undefined {
  if (Object.prototype.hasOwnProperty.call(BROWSER_TO_RUNTIME_ERROR_KIND, code)) {
    return BROWSER_TO_RUNTIME_ERROR_KIND[code as BridgedBrowserErrorCode];
  }
  return undefined;
}
