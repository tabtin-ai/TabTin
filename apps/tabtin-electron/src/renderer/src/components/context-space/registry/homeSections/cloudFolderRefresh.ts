/**
 * ：云盘 Organization Collection 自愈刷新。
 * WS 为主路径；activate / reconnect 补偿漏推与断线。
 */

import { useCollections } from '@/stores/useCollections'
import { createLogger } from '@/utils/logger'

const log = createLogger('CloudFolderRefresh')

export type CloudFolderRefreshSource = 'ws' | 'activate' | 'reconnect'

/** 云盘 apphome tab 从后台变为活动时需要强制补拉 */
export function shouldForceCloudFolderRefreshOnActivate(
  wasActive: boolean,
  isActive: boolean,
): boolean {
  return isActive && !wasActive
}

export function forceRefreshOrganizationCollections(
  organizationId: string,
  source: CloudFolderRefreshSource,
): Promise<void> {
  log.info('organization collections refresh', { source, organizationId })
  return useCollections.getState().loadOrganization(organizationId, true).then(() => {
    const state = useCollections.getState()
    const error = state.errorByOrganizationId?.[organizationId]
    if (error) {
      log.warn('organization collections refresh failed', { source, organizationId, error })
      return
    }
    const count = state.collectionsByOrganizationId?.[organizationId]?.length ?? 0
    log.info('organization collections refresh done', { source, organizationId, count })
  })
}
