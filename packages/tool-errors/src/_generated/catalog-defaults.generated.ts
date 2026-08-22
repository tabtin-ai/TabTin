/**
 * **AUTO-GENERATED — DO NOT EDIT BY HAND**
 *
 * Source: packages/tool-errors/codegen/kinds/*.yaml
 *        + file-pipeline-errors/codegen/error-codes.yaml (specific kinds)
 * Codegen: pnpm --filter @tabtin/tool-errors codegen
 *
 * Electron merges these defaults with hand-written UX overrides.
 * No hint copy / Factory / retry policy here.
 */

export interface ToolErrorCatalogEntry {
  soft: boolean;
  translatable: boolean;
  countsAsAnomaly: boolean;
  userInitiated: boolean;
}

export const TOOL_ERROR_CATALOG_DEFAULTS: Readonly<
  Record<string, ToolErrorCatalogEntry>
> = {
  budget_skipped: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  aborted: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: true,
  },
  aborted_by_user: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: true,
  },
  tool_timeout: {
    soft: true,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  execute_error: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  unknown_tool: {
    soft: false,
    translatable: false,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  schema_invalid: {
    soft: false,
    translatable: false,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  validate_input: {
    soft: false,
    translatable: false,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  plan_guard_deny: {
    soft: false,
    translatable: false,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  missing_required_param: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  invalid_param_format: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  param_too_large: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  mutually_exclusive_params: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  no_ui_session: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  runtime_misconfig: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  host_unsupported: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  network_failed: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  request_timeout: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  auth_failed: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  permission_denied: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  resource_not_found: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  document_not_ready: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  rate_limited: {
    soft: true,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  upstream_error: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  skill_unsupported_prefix: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  skill_not_found: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  skill_disabled: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  skill_not_ready: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  skill_not_installed: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  version_conflict: {
    soft: true,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  tool_stale_read: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  old_string_not_found: {
    soft: false,
    translatable: false,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  old_string_not_unique: {
    soft: false,
    translatable: false,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  command_blocked_by_policy: {
    soft: true,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  command_denied_by_validator: {
    soft: true,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  mode_restricted: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  cwd_not_found: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  spawn_failure: {
    soft: false,
    translatable: false,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  os_access_error: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  widget_render_failed: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  internal_error: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  requires_client_approval: {
    soft: true,
    translatable: false,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  already_pending: {
    soft: true,
    translatable: false,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  todo_list_already_open: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  todo_list_not_open: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  todo_item_frozen: {
    soft: true,
    translatable: true,
    countsAsAnomaly: false,
    userInitiated: false,
  },
  todo_invalid_items: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  file_not_found: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  file_too_large: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  encrypted: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  corrupted: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  scanned_pdf: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  garbled_text_layer: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  unsupported_format: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  parse_timeout: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
  image_resize_failed: {
    soft: false,
    translatable: true,
    countsAsAnomaly: true,
    userInitiated: false,
  },
};
