import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import { withTimeout, DEFAULT_IPC_TIMEOUT, LONG_IPC_TIMEOUT } from '../utils/withTimeout'

function getApi(): any | null {
  if (typeof window === 'undefined') return null
  const tabtin = window.tabtin
  return tabtin?.agent || null
}

export const agentClient = {
  executeAction: async (params: any) => {
    const api = getApi()
    if (!api?.executeAction) throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'agent.executeAction' }))
    const actionType = params?.action ?? params?.type
    if (actionType && api?.hasToolForAction) {
      const available = await withTimeout(api.hasToolForAction(actionType), DEFAULT_IPC_TIMEOUT, 'agent.hasToolForAction')
      if (!available) {
        toast({
          title: i18n.t('crawl:clients.toolUnavailableTitle'),
          description: i18n.t('crawl:clients.toolUnavailableDescription', { action: actionType })
        })
        return {
          success: false,
          error: i18n.t('crawl:clients.toolUnavailableDescription', { action: actionType })
        }
      }
    }
    return withTimeout(api.executeAction(params), LONG_IPC_TIMEOUT, 'agent.executeAction')
  },
  getRegisteredTools: async (): Promise<string[]> => {
    const api = getApi()
    if (!api?.getRegisteredTools) {
      throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'agent.getRegisteredTools' }))
    }
    return withTimeout(api.getRegisteredTools(), DEFAULT_IPC_TIMEOUT, 'agent.getRegisteredTools')
  },
  hasToolForAction: async (actionType: string): Promise<boolean> => {
    const api = getApi()
    if (!api?.hasToolForAction) {
      throw new Error(i18n.t('crawl:clients.apiUnavailable', { api: 'agent.hasToolForAction' }))
    }
    return withTimeout(api.hasToolForAction(actionType), DEFAULT_IPC_TIMEOUT, 'agent.hasToolForAction')
  }
}
