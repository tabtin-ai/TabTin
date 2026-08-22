/**
 * `organization.updated` 事件处理器
 *
 * owner / admin 修改组织资料后，服务端 fan-out 到全部成员；本 handler 将
 * payload 增量合并进 `useOrganizationStore`，避免每次全量 loadOrganizations。
 */

import { useOrganizationStore, type Organization } from '@tabtin/app-shell'
import { logger } from '@/utils/logger'

interface OrganizationUpdatedPayload {
  organization_id?: unknown
  name?: unknown
  description?: unknown
  icon?: unknown
  settings?: unknown
  updated_at?: unknown
}

function buildOrganizationPatch(payload: OrganizationUpdatedPayload): (Partial<Organization> & { id: string }) | null {
  const organizationId = typeof payload.organization_id === 'string' ? payload.organization_id.trim() : ''
  if (!organizationId) return null

  const patch: Partial<Organization> & { id: string } = { id: organizationId }

  if (typeof payload.name === 'string') {
    patch.name = payload.name
  }
  if (typeof payload.description === 'string') {
    patch.description = payload.description
  }
  if (typeof payload.icon === 'string') {
    patch.icon = payload.icon
  }
  if (payload.settings && typeof payload.settings === 'object' && !Array.isArray(payload.settings)) {
    patch.settings = payload.settings as Organization['settings']
  }
  if (typeof payload.updated_at === 'string') {
    patch.updated_at = payload.updated_at
  }

  return patch
}

export function handleOrganizationUpdatedEnvelope(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return

  const patch = buildOrganizationPatch(payload as OrganizationUpdatedPayload)
  if (!patch) return

  logger.info(
    '[OrganizationProfile] organization.updated organization=%s name=%s',
    patch.id.slice(0, 8),
    typeof patch.name === 'string' ? patch.name : '(unchanged)',
  )

  useOrganizationStore.getState().applyOrganizationProfileUpdate(patch)
}
