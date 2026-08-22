/**
 * @tabtin/tool-errors
 *
 * Generative SSoT for tool error_kind literals, Electron catalog defaults,
 * i18n key inventory, and browser/action → runtime string bridges.
 *
 * Out of scope (Wave 3+): numeric error_code, Factory, retry policy, hint copy.
 */

export {
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
  TOOL_LAYER_ERROR_KINDS,
  type ToolLayerErrorKind,
} from './_generated/kinds.generated.js';

export {
  TOOL_ERROR_CATALOG_DEFAULTS,
  type ToolErrorCatalogEntry,
} from './_generated/catalog-defaults.generated.js';

export { TOOL_ERROR_I18N_KEYS } from './_generated/i18n-keys.generated.js';

export {
  BROWSER_TO_RUNTIME_ERROR_KIND,
  bridgeBrowserErrorCodeToRuntimeKind,
  type BridgedBrowserErrorCode,
  type BridgedRuntimeErrorKind,
} from './_generated/bridges.generated.js';
