import i18n from '@/i18n'
import { withTimeout, DEFAULT_IPC_TIMEOUT } from '../utils/withTimeout'
import { createLogger } from '@/utils/logger'

const log = createLogger('TaskApiClient')

function getApi(): any | null {
  if (typeof window === 'undefined') return null
  return window.tabtin?.taskAPI ?? null
}

export const taskApiClient = {
  create: async (config: any) => {
    const api = getApi()
    if (!api?.create) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'taskAPI.create' }))
    return withTimeout(api.create(config), DEFAULT_IPC_TIMEOUT, 'taskAPI.create')
  },
  get: async (taskId: string) => {
    const api = getApi()
    if (!api?.get) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'taskAPI.get' }))
    return withTimeout(api.get(taskId), DEFAULT_IPC_TIMEOUT, 'taskAPI.get')
  },
  enqueue: async (taskId: string) => {
    const api = getApi()
    if (!api?.enqueue) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'taskAPI.enqueue' }))
    return withTimeout(api.enqueue(taskId), DEFAULT_IPC_TIMEOUT, 'taskAPI.enqueue')
  },
  cancel: async (taskId: string) => {
    const api = getApi()
    if (!api?.cancel) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'taskAPI.cancel' }))
    return withTimeout(api.cancel(taskId), DEFAULT_IPC_TIMEOUT, 'taskAPI.cancel')
  },
  resume: async (taskId: string) => {
    const api = getApi()
    if (!api?.resume) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'taskAPI.resume' }))
    return withTimeout(api.resume(taskId), DEFAULT_IPC_TIMEOUT, 'taskAPI.resume')
  },
  resumeWithPagination: async (params: any) => {
    const api = getApi()
    if (!api?.resumeWithPagination) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'taskAPI.resumeWithPagination' }))
    return withTimeout(api.resumeWithPagination(params), DEFAULT_IPC_TIMEOUT, 'taskAPI.resumeWithPagination')
  },
  selectRecommendation: async (params: any) => {
    const api = getApi()
    if (!api?.selectRecommendation) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'taskAPI.selectRecommendation' }))
    return withTimeout(api.selectRecommendation(params), DEFAULT_IPC_TIMEOUT, 'taskAPI.selectRecommendation')
  },
  updateMetadata: async (taskId: string, metadata: Record<string, any>) => {
    const api = getApi()
    if (!api?.updateMetadata) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'taskAPI.updateMetadata' }))
    return withTimeout(api.updateMetadata(taskId, metadata), DEFAULT_IPC_TIMEOUT, 'taskAPI.updateMetadata')
  },
  onStateChange: (callback: (event: any) => void): (() => void) => {
    const api = getApi()
    if (!api?.onStateChange) {
      log.warn('API 不可用:', { api: 'taskAPI.onStateChange' })
      return () => {}
    }
    const unsub = api.onStateChange(callback)
    if (typeof unsub !== 'function') {
      log.warn('onStateChange did not return an unsubscribe function')
      return () => {}
    }
    return unsub
  }
}
