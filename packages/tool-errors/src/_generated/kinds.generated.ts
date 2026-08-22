/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/tool-errors/codegen/kinds/*.yaml
 * Codegen: pnpm --filter @tabtin/tool-errors codegen
 *
 * Tool-layer error_kind constants + TOOL_LAYER_ERROR_KINDS.
 * File-pipeline kinds are NOT listed here — agent-runtime re-exports
 * @tabtin/file-pipeline-errors and merges into TOOL_ERROR_KINDS.
 */

export const MISSING_REQUIRED_PARAM = 'missing_required_param' as const;
export const INVALID_PARAM_FORMAT = 'invalid_param_format' as const;
export const PARAM_TOO_LARGE = 'param_too_large' as const;
export const MUTUALLY_EXCLUSIVE_PARAMS = 'mutually_exclusive_params' as const;
export const NO_UI_SESSION = 'no_ui_session' as const;
export const RUNTIME_MISCONFIG = 'runtime_misconfig' as const;
export const HOST_UNSUPPORTED = 'host_unsupported' as const;
export const NETWORK_FAILED = 'network_failed' as const;
export const REQUEST_TIMEOUT = 'request_timeout' as const;
export const AUTH_FAILED = 'auth_failed' as const;
export const PERMISSION_DENIED = 'permission_denied' as const;
export const RESOURCE_NOT_FOUND = 'resource_not_found' as const;
export const DOCUMENT_NOT_READY = 'document_not_ready' as const;
export const RATE_LIMITED = 'rate_limited' as const;
export const UPSTREAM_ERROR = 'upstream_error' as const;
export const SKILL_UNSUPPORTED_PREFIX = 'skill_unsupported_prefix' as const;
export const SKILL_NOT_FOUND = 'skill_not_found' as const;
export const SKILL_DISABLED = 'skill_disabled' as const;
export const SKILL_NOT_READY = 'skill_not_ready' as const;
export const SKILL_NOT_INSTALLED = 'skill_not_installed' as const;
export const VERSION_CONFLICT = 'version_conflict' as const;
export const TOOL_STALE_READ = 'tool_stale_read' as const;
export const OLD_STRING_NOT_FOUND = 'old_string_not_found' as const;
export const OLD_STRING_NOT_UNIQUE = 'old_string_not_unique' as const;
export const COMMAND_BLOCKED_BY_POLICY = 'command_blocked_by_policy' as const;
export const COMMAND_DENIED_BY_VALIDATOR = 'command_denied_by_validator' as const;
export const MODE_RESTRICTED = 'mode_restricted' as const;
export const CWD_NOT_FOUND = 'cwd_not_found' as const;
export const SPAWN_FAILURE = 'spawn_failure' as const;
export const OS_ACCESS_ERROR = 'os_access_error' as const;
export const WIDGET_RENDER_FAILED = 'widget_render_failed' as const;
export const INTERNAL_ERROR = 'internal_error' as const;
export const REQUIRES_CLIENT_APPROVAL = 'requires_client_approval' as const;
export const ALREADY_PENDING = 'already_pending' as const;
export const TODO_LIST_ALREADY_OPEN = 'todo_list_already_open' as const;
export const TODO_LIST_NOT_OPEN = 'todo_list_not_open' as const;
export const TODO_ITEM_FROZEN = 'todo_item_frozen' as const;
export const TODO_INVALID_ITEMS = 'todo_invalid_items' as const;

export type ToolLayerErrorKind =
  | typeof MISSING_REQUIRED_PARAM
  | typeof INVALID_PARAM_FORMAT
  | typeof PARAM_TOO_LARGE
  | typeof MUTUALLY_EXCLUSIVE_PARAMS
  | typeof NO_UI_SESSION
  | typeof RUNTIME_MISCONFIG
  | typeof HOST_UNSUPPORTED
  | typeof NETWORK_FAILED
  | typeof REQUEST_TIMEOUT
  | typeof AUTH_FAILED
  | typeof PERMISSION_DENIED
  | typeof RESOURCE_NOT_FOUND
  | typeof DOCUMENT_NOT_READY
  | typeof RATE_LIMITED
  | typeof UPSTREAM_ERROR
  | typeof SKILL_UNSUPPORTED_PREFIX
  | typeof SKILL_NOT_FOUND
  | typeof SKILL_DISABLED
  | typeof SKILL_NOT_READY
  | typeof SKILL_NOT_INSTALLED
  | typeof VERSION_CONFLICT
  | typeof TOOL_STALE_READ
  | typeof OLD_STRING_NOT_FOUND
  | typeof OLD_STRING_NOT_UNIQUE
  | typeof COMMAND_BLOCKED_BY_POLICY
  | typeof COMMAND_DENIED_BY_VALIDATOR
  | typeof MODE_RESTRICTED
  | typeof CWD_NOT_FOUND
  | typeof SPAWN_FAILURE
  | typeof OS_ACCESS_ERROR
  | typeof WIDGET_RENDER_FAILED
  | typeof INTERNAL_ERROR
  | typeof REQUIRES_CLIENT_APPROVAL
  | typeof ALREADY_PENDING
  | typeof TODO_LIST_ALREADY_OPEN
  | typeof TODO_LIST_NOT_OPEN
  | typeof TODO_ITEM_FROZEN
  | typeof TODO_INVALID_ITEMS;

export const TOOL_LAYER_ERROR_KINDS: readonly ToolLayerErrorKind[] = [
  MISSING_REQUIRED_PARAM,
  INVALID_PARAM_FORMAT,
  PARAM_TOO_LARGE,
  MUTUALLY_EXCLUSIVE_PARAMS,
  NO_UI_SESSION,
  RUNTIME_MISCONFIG,
  HOST_UNSUPPORTED,
  NETWORK_FAILED,
  REQUEST_TIMEOUT,
  AUTH_FAILED,
  PERMISSION_DENIED,
  RESOURCE_NOT_FOUND,
  DOCUMENT_NOT_READY,
  RATE_LIMITED,
  UPSTREAM_ERROR,
  SKILL_UNSUPPORTED_PREFIX,
  SKILL_NOT_FOUND,
  SKILL_DISABLED,
  SKILL_NOT_READY,
  SKILL_NOT_INSTALLED,
  VERSION_CONFLICT,
  TOOL_STALE_READ,
  OLD_STRING_NOT_FOUND,
  OLD_STRING_NOT_UNIQUE,
  COMMAND_BLOCKED_BY_POLICY,
  COMMAND_DENIED_BY_VALIDATOR,
  MODE_RESTRICTED,
  CWD_NOT_FOUND,
  SPAWN_FAILURE,
  OS_ACCESS_ERROR,
  WIDGET_RENDER_FAILED,
  INTERNAL_ERROR,
  REQUIRES_CLIENT_APPROVAL,
  ALREADY_PENDING,
  TODO_LIST_ALREADY_OPEN,
  TODO_LIST_NOT_OPEN,
  TODO_ITEM_FROZEN,
  TODO_INVALID_ITEMS,
] as const;
