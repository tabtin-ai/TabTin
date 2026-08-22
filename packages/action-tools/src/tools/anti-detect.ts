import type { AgentTool } from '../types'
import {
  getSharedAntiDetectToolImpl,
  type GetRandomUAInput,
  type GetRandomUAOutput,
  type CheckProxyHealthInput,
  type CheckProxyHealthOutput
} from '../impl/AntiDetectToolImpl'
import { standardizeLegacyResult } from '../utils/tool-output'
import { t } from '../i18n'

// 🔥 重新导出类型，以便从本模块导出
export type { GetRandomUAInput, GetRandomUAOutput, CheckProxyHealthInput, CheckProxyHealthOutput }

export const getRandomUATool: AgentTool<GetRandomUAInput, GetRandomUAOutput> = {
  name: 'get_random_ua',
  description: t('tools.antiDetect.getRandomUA.description'),
  parameters: {
    type: 'object',
    properties: {
      platform: {
        type: 'string',
        enum: ['desktop', 'mobile', 'tablet'],
        description: t('tools.antiDetect.getRandomUA.params.platform')
      },
      userAgents: {
        type: 'array',
        description: t('tools.antiDetect.getRandomUA.params.userAgents'),
        items: { type: 'string' }
      },
      rotation: {
        type: 'string',
        enum: ['random', 'sequential'],
        description: t('tools.antiDetect.getRandomUA.params.rotation'),
        default: 'random'
      }
    },
    required: []
  },
  async execute(input: GetRandomUAInput): Promise<GetRandomUAOutput> {
    const impl = getSharedAntiDetectToolImpl()
    const result = impl.getRandomUA(input)
    return standardizeLegacyResult(result)
  }
}

export const checkProxyHealthTool: AgentTool<CheckProxyHealthInput, CheckProxyHealthOutput> = {
  name: 'check_proxy_health',
  description: t('tools.antiDetect.checkProxyHealth.description'),
  parameters: {
    type: 'object',
    properties: {
      proxy: {
        type: 'object',
        description: t('tools.antiDetect.checkProxyHealth.params.proxy')
      },
      timeoutMs: {
        type: 'number',
        description: t('tools.antiDetect.checkProxyHealth.params.timeoutMs'),
        default: 3000
      }
    },
    required: ['proxy']
  },
  async execute(input: CheckProxyHealthInput): Promise<CheckProxyHealthOutput> {
    const impl = getSharedAntiDetectToolImpl()
    const result = await impl.checkProxyHealth(input)
    return standardizeLegacyResult(result)
  }
}

export const antiDetectTools = [getRandomUATool, checkProxyHealthTool]
