import i18n from '@/i18n'
import { withTimeout, DEFAULT_IPC_TIMEOUT } from '../utils/withTimeout'

function getApi(): any | null {
  return (typeof window !== 'undefined' ? window.tabtin?.runSession : null) ?? null
}

export const runSessionClient = {
  create: async (runId: string, sessionId?: string) => {
    const api = getApi()
    if (!api?.create) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'runSession.create' }))
    return withTimeout(api.create(runId, sessionId) as Promise<unknown>, DEFAULT_IPC_TIMEOUT, 'runSession.create')
  },
  endRun: async (runId: string, options?: { destroyViews?: boolean; reason?: string }) => {
    const api = getApi()
    if (!api?.endRun) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'runSession.endRun' }))
    return withTimeout(api.endRun(runId, options) as Promise<unknown>, DEFAULT_IPC_TIMEOUT, 'runSession.endRun')
  },
}
