/**
 * Extension API Service
 *
 * 封装 /api/extensions/* 后端接口。
 */

import { joinApiPath } from '@tabtin/config'
import { API_CONFIG } from '@/config/api'
import { apiRequest, getAuthToken } from '@/adapters/api-adapter-instance'
import type { TableHttpMethod } from '@tabtin/table-core'

// ── Types ────────────────────────────────────────────────────────────

export interface ExtensionCapabilities {
  has_tools: boolean
  has_cli: boolean
  has_events: boolean
  has_inbound_webhook: boolean
  has_ui: boolean
  supports_oauth: boolean
  supports_polling: boolean
}

export interface PayloadFieldDescriptor {
  key: string
  label: string
  type: string
  example: string
}

export interface ExtensionEventType {
  event_type: string
  description: string
  payload_fields: PayloadFieldDescriptor[]
}

export interface ExtensionManifest {
  id: string
  name: string
  description: string
  icon: string
  type: string
  is_builtin?: boolean
  capabilities: ExtensionCapabilities
  config_schema: Record<string, unknown>
  event_types: ExtensionEventType[]
}

export interface ExtensionConnection {
  id: string
  extension_id: string
  organization_id: string
  space_id: string | null
  name: string | null
  enabled: boolean
  status: string
  auth_type: string
  config_masked: Record<string, unknown>
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface CreateConnectionPayload {
  extension_id: string
  space_id?: string
  name?: string
  auth_type?: string
  config?: Record<string, unknown>
}

export interface UpdateConnectionPayload {
  name?: string
  enabled?: boolean
  auth_type?: string
  config?: Record<string, unknown>
}

export interface WebhookSubscription {
  id: string
  organization_id: string
  space_id: string | null
  url: string
  event_types: string[]
  is_active: boolean
  max_retries: number
  total_deliveries: number
  failed_deliveries: number
  consecutive_failures: number
  last_triggered_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateWebhookPayload {
  url: string
  secret?: string
  event_types?: string[]
  is_active?: boolean
  max_retries?: number
  space_id?: string
}

export interface UpdateWebhookPayload {
  url?: string
  secret?: string
  event_types?: string[]
  is_active?: boolean
  max_retries?: number
}

export interface ExtensionCliOptionDescriptor {
  flag: string
  description: string
}

export interface ExtensionCliCommandDescriptor {
  extension_id: string
  name: string
  description: string
  api_endpoint: string
  method: string
  options: ExtensionCliOptionDescriptor[]
}

// ── Internal helpers ─────────────────────────────────────────────────

async function extRequest<T>(
  method: TableHttpMethod,
  path: string,
  organizationId: string,
  body?: unknown,
): Promise<T> {
  const token = await getAuthToken()
  const url = joinApiPath(API_CONFIG.baseURL, `/extensions${path}`)

  const response = await apiRequest<T>({
    url,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Organization-Id': organizationId,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  const data = response.data
  if (response.status >= 400) {
    const msg = (data as Record<string, unknown>)?.error
    throw new Error(typeof msg === 'string' ? msg : `Extension API error: ${response.status}`)
  }
  if (data === undefined || data === null) {
    throw new Error(`Extension API returned empty response (${response.status})`)
  }
  return data as T
}

// ── Extensions ───────────────────────────────────────────────────────

export async function listExtensions(
  organizationId: string,
): Promise<{ ok: boolean; extensions: ExtensionManifest[] }> {
  return extRequest('GET', '/', organizationId)
}

export async function listCliCommands(): Promise<{ commands: ExtensionCliCommandDescriptor[] }> {
  const token = await getAuthToken().catch(() => '')
  const response = await apiRequest<{
    success?: boolean
    data?: { commands?: ExtensionCliCommandDescriptor[] }
    commands?: ExtensionCliCommandDescriptor[]
  }>({
    url: joinApiPath(API_CONFIG.baseURL, `/extensions/cli-commands/`),
    method: 'GET',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })

  if (response.status >= 400) {
    throw new Error(`Extension CLI API error: ${response.status}`)
  }

  const data = response.data
  return {
    commands: data?.data?.commands ?? data?.commands ?? [],
  }
}

export async function getExtension(
  organizationId: string,
  extensionId: string,
): Promise<{ ok: boolean; extension: ExtensionManifest }> {
  return extRequest('GET', `/${extensionId}/`, organizationId)
}

// ── Builtin auto-connection ──────────────────────────────────────────

export async function ensureBuiltinConnections(
  organizationId: string,
): Promise<{ ok: boolean; created: number }> {
  return extRequest('POST', '/ensure-builtins/', organizationId)
}

// ── Connections ──────────────────────────────────────────────────────

export async function listConnections(
  organizationId: string,
  spaceId?: string,
): Promise<{ ok: boolean; connections: ExtensionConnection[] }> {
  const params = spaceId ? `?space_id=${encodeURIComponent(spaceId)}` : ''
  return extRequest('GET', `/connections/${params}`, organizationId)
}

export async function getConnection(
  organizationId: string,
  connectionId: string,
): Promise<{ ok: boolean; connection: ExtensionConnection }> {
  return extRequest('GET', `/connections/${connectionId}/`, organizationId)
}

export async function createConnection(
  organizationId: string,
  payload: CreateConnectionPayload,
): Promise<{ ok: boolean; connection: ExtensionConnection; created: boolean }> {
  return extRequest('POST', `/connections/create/`, organizationId, payload)
}

export async function updateConnection(
  organizationId: string,
  connectionId: string,
  payload: UpdateConnectionPayload,
): Promise<{ ok: boolean; connection: ExtensionConnection }> {
  return extRequest('PATCH', `/connections/${connectionId}/update/`, organizationId, payload)
}

export async function deleteConnection(
  organizationId: string,
  connectionId: string,
): Promise<{ ok: boolean }> {
  return extRequest('DELETE', `/connections/${connectionId}/delete/`, organizationId)
}

// ── Webhooks ─────────────────────────────────────────────────────────

export async function listWebhooks(
  organizationId: string,
): Promise<{ ok: boolean; webhooks: WebhookSubscription[] }> {
  return extRequest('GET', `/webhooks/`, organizationId)
}

export async function createWebhook(
  organizationId: string,
  payload: CreateWebhookPayload,
): Promise<{ ok: boolean; webhook: WebhookSubscription }> {
  return extRequest('POST', `/webhooks/create/`, organizationId, payload)
}

export async function updateWebhook(
  organizationId: string,
  webhookId: string,
  payload: UpdateWebhookPayload,
): Promise<{ ok: boolean; webhook: WebhookSubscription }> {
  return extRequest('PATCH', `/webhooks/${webhookId}/update/`, organizationId, payload)
}

export async function deleteWebhook(
  organizationId: string,
  webhookId: string,
): Promise<{ ok: boolean }> {
  return extRequest('DELETE', `/webhooks/${webhookId}/delete/`, organizationId)
}

// ── Probe ─────────────────────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean
  error: string | null
  latency_ms: number | null
}

export async function probeConnection(
  organizationId: string,
  connectionId: string,
): Promise<{ ok: boolean; probe: ProbeResult; connection: ExtensionConnection }> {
  return extRequest('POST', `/connections/${connectionId}/probe/`, organizationId)
}

// ── Event Logs ────────────────────────────────────────────────────────

export interface EventLog {
  id: string
  extension_id: string
  connection_id: string | null
  organization_id: string
  space_id: string | null
  event_type: string
  status: string
  error_message: string | null
  created_at: string
  processed_at: string | null
}

export interface EventLogListParams {
  extension_id?: string
  event_type?: string
  status?: string
  limit?: number
  offset?: number
}

export async function listEventLogs(
  organizationId: string,
  params?: EventLogListParams,
): Promise<{ ok: boolean; total: number; offset: number; limit: number; logs: EventLog[] }> {
  const search = new URLSearchParams()
  if (params?.extension_id) search.set('extension_id', params.extension_id)
  if (params?.event_type) search.set('event_type', params.event_type)
  if (params?.status) search.set('status', params.status)
  if (params?.limit) search.set('limit', String(params.limit))
  if (params?.offset) search.set('offset', String(params.offset))
  const qs = search.toString()
  return extRequest('GET', `/event-logs/${qs ? `?${qs}` : ''}`, organizationId)
}

// ── Notification Rules ────────────────────────────────────────────

export interface NotificationRule {
  id: string
  organization_id: string
  space_id: string | null
  event_pattern: string
  source_extension_id: string
  channels: string[]
  priority: string
  category: string
  title_template: string
  body_template: string
  enabled: boolean
  is_system: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export async function listNotificationRules(
  organizationId: string,
  spaceId?: string,
): Promise<{ ok: boolean; rules: NotificationRule[] }> {
  const qs = spaceId ? `?space_id=${encodeURIComponent(spaceId)}` : ''
  return extRequest('GET', `/notification-rules/${qs}`, organizationId)
}

export async function createNotificationRule(
  organizationId: string,
  data: Partial<NotificationRule>,
): Promise<{ ok: boolean; rule: NotificationRule }> {
  return extRequest('POST', '/notification-rules/create/', organizationId, data)
}

export async function updateNotificationRule(
  organizationId: string,
  ruleId: string,
  data: Partial<NotificationRule>,
): Promise<{ ok: boolean; rule: NotificationRule }> {
  return extRequest('PATCH', `/notification-rules/${ruleId}/update/`, organizationId, data)
}

export async function deleteNotificationRule(
  organizationId: string,
  ruleId: string,
): Promise<{ ok: boolean }> {
  return extRequest('DELETE', `/notification-rules/${ruleId}/delete/`, organizationId)
}

export async function seedNotificationRules(
  organizationId: string,
): Promise<{ ok: boolean; created: number }> {
  return extRequest('POST', '/notification-rules/seed/', organizationId)
}
