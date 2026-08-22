/**
 * 删除单条本机外部档案，并刷新侧栏索引。
 */

import { createLogger } from '@/utils/logger'
import { forgetExternalOpenedSession } from './externalOpenedSessionRegistry'
import { useExternalArchiveIndexStore } from './useExternalArchiveIndexStore'

const log = createLogger('ExternalArchiveDelete')

export async function deleteExternalArchive(payload: {
  organizationId: string
  source: string
  sourceSessionId: string
  openedSessionId?: string | null
}): Promise<{ deleted: number }> {
  const api = window.tabtin?.import
  if (!api?.deleteArchive) {
    throw new Error('当前客户端未暴露删除外部档案接口')
  }

  const result = await api.deleteArchive({
    organizationId: payload.organizationId,
    source: payload.source,
    sourceSessionId: payload.sourceSessionId,
  }) as { deleted: number }

  const deleted = result?.deleted ?? 0
  if (deleted > 0) {
    const openedId = payload.openedSessionId?.trim()
    if (openedId) {
      forgetExternalOpenedSession(openedId)
    }
    useExternalArchiveIndexStore.getState().bump()
    log.info('已删除外部档案', {
      source: payload.source,
      sourceSessionId: payload.sourceSessionId,
      deleted,
    })
  } else {
    log.warn('删除外部档案未命中任何条目', {
      source: payload.source,
      sourceSessionId: payload.sourceSessionId,
    })
  }
  return { deleted }
}
