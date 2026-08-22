/**
 * Tins 类型定义
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ---------------------------------------------------------------------------
// Permission model — browser-extension-style declared permissions
// ---------------------------------------------------------------------------

export const TinPermission = {
  PAGE_URL: 'page:url',
  PAGE_TITLE: 'page:title',
  PAGE_CONTENT: 'page:content',
  PAGE_SELECTION: 'page:selection',
  PAGE_INJECT: 'page_inject',
  VARIABLES: 'variables',
  UI_TOAST: 'ui:toast',
  UI_RESIZE: 'ui:resize',
  AGENT_INVOKE: 'agent:invoke',
  TABLE_WRITE: 'table:write',
  GOAL_TRIGGER: 'goal:trigger',
} as const

export type TinPermissionValue = typeof TinPermission[keyof typeof TinPermission]

/**
 * Maps each Bridge message type to the permission(s) it requires.
 * An API with no entry here is allowed without any permission (basic/free).
 */
export const BRIDGE_API_PERMISSIONS: Record<string, TinPermissionValue[]> = {
  getPageUrl: [TinPermission.PAGE_URL],
  getPageTitle: [TinPermission.PAGE_TITLE],
  getPageContent: [TinPermission.PAGE_CONTENT],
  getPageSelection: [TinPermission.PAGE_SELECTION],
  getVariable: [TinPermission.VARIABLES],
  setVariable: [TinPermission.VARIABLES],
  showToast: [TinPermission.UI_TOAST],
  resize: [TinPermission.UI_RESIZE],
  runAgent: [TinPermission.AGENT_INVOKE],
  triggerGoal: [TinPermission.GOAL_TRIGGER],
  writeToTable: [TinPermission.TABLE_WRITE],
}

/**
 * Check whether the granted permissions cover a Bridge API call.
 */
export function hasPermissionForApi(
  grantedPermissions: string[],
  apiType: string,
): { allowed: boolean; missing: string[] } {
  const required = BRIDGE_API_PERMISSIONS[apiType]
  if (!required || required.length === 0) {
    return { allowed: true, missing: [] }
  }
  const granted = new Set(grantedPermissions)
  const missing = required.filter((p) => !granted.has(p))
  return { allowed: missing.length === 0, missing }
}

export interface ActivationRule {
  type: 'url_pattern' | 'page_language' | 'title_url_match' | 'page_content' | 'always'
  patterns?: string[]
  languages?: string[]
  keywords?: string[]
}

/**
 * NOTE: 'page_content' is deprecated — it does NOT actually match page body content.
 * At runtime it falls back to 'title_url_match' behavior (matching title+url string).
 * Kept in the union for backward compatibility with existing Tin definitions.
 * Django schema should reject new 'page_content' rules (see SD-033).
 */

export interface VariableSchema {
  type: 'text' | 'select' | 'number' | 'boolean'
  label: string
  default?: unknown
  options?: string[]
}

export interface TinManifest {
  name: string
  description: string
  version: string
  activation: {
    mode: 'auto' | 'suggest' | 'manual'
    rules: ActivationRule[]
    match: 'any' | 'all'
  }
  variables: Record<string, VariableSchema>
  permissions: string[]
  ui: {
    panel_position: 'sidebar_right' | 'sidebar_left' | 'bottom_panel' | 'overlay'
    width: number
    entry: string
  }
}

export interface TinDefinition {
  id: string
  organization_id: string
  space_id?: string
  name: string
  description: string
  icon_url: string
  version: string
  status: 'draft' | 'active' | 'disabled'
  source: 'agent_generated' | 'user_created' | 'market' | 'shared'

  activation_mode: string
  activation_rules: ActivationRule[]
  activation_match: string
  variables_schema: Record<string, VariableSchema>
  permissions: string[]
  panel_position: string
  panel_width: number

  panel_html: string
  content_script?: string
  background_script?: string
  agent_instructions?: string
  manifest?: TinManifest

  created_by?: string
  created_at: string
  updated_at: string
}

export interface TinInstance {
  id: string
  tin_id: string
  organization_id: string
  space_id: string
  is_enabled: boolean
  pinned: boolean
  user_variables: Record<string, unknown>
  last_activated_at?: string
  created_at: string
  updated_at: string
  tin: TinDefinition
}

export interface TinActivationState {
  instanceId: string
  tinId: string
  name: string
  isActive: boolean
  activatedAt?: number
  panelVisible: boolean
}

export type TinBridgeMessage =
  | { type: 'getPageUrl' }
  | { type: 'getPageTitle' }
  | { type: 'getPageContent'; options?: { format: 'text' | 'html' | 'markdown' } }
  | { type: 'getPageSelection' }
  | { type: 'getVariable'; name: string }
  | { type: 'setVariable'; name: string; value: unknown }
  | { type: 'showToast'; message: string; toastType?: 'info' | 'success' | 'error' }
  | { type: 'resize'; width?: number; height?: number }
  | { type: 'runAgent'; instruction: string }
  | { type: 'triggerGoal'; goalId: string; params?: Record<string, unknown> }
  | { type: 'writeToTable'; tableId: string; records: Record<string, unknown>[] }

// Note: legacy `TinBridgeResponse` interface (with `id` / `success` / `error` fields)
// was removed in W2-δ — `tin-bridge:request` now returns a `CliResponse` envelope
// from `@tabtin/agent-wire` (see `tin-bridge.ts::handleBridgeMessage`).
// Sandbox callers consume the envelope via `bridgeRequest()` in
// `generateTinPreloadScript`, which throws on `ok:false` and returns
// `envelope.data` on `ok:true` — sandbox third-party code thus uses
// the standard "return value or throw" JS pattern, not the envelope shape.
