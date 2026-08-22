/**
 * 开号流程（ 分身版）：模板实例化 / 空白自建 bot Agent 的共享执行链。
 *
 * NewAgentDialog（切换器「＋ 开新分身」）共用本函数。
 * 正典：只 POST /agents 建身份；选中由调用方回调处理（不建/切 Workspace，不开草稿）。
 */

import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui/toast'
import type { Agent } from '@tabtin/app-shell'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { AGENT_LIMIT_EXCEEDED_CODE, createBotAgent } from './agentTemplatesApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('AgentProvision')

function extractErrorCode(error: unknown): string | null {
  const data = (error as { data?: unknown })?.data
  if (data && typeof data === 'object') {
    const code = (data as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

export interface ProvisionBotAgentInput {
  /** 目标组织；会话内入口必须显式传入，禁止用全局当前组织猜测。 */
  organizationId?: string
  name: string
  /** 模板 slug；缺省 = 从空白自建（占自建配额） */
  templateId?: string
  /** 平台品牌头像标识；创建流程只接受随包预设。 */
  avatarKey?: string
  /**
   * 身份已创建后、调用方处理选中之前调用。
   * 创建弹窗应在此收起，避免后续 store 更新把受控 Dialog 卡住。
   */
  onCreated?: () => void
}

export interface ProvisionBotAgentResult {
  ok: boolean
  /** 创建出的 Agent（成功时） */
  agent?: Agent
}

/**
 * 实例化 / 自建一个 bot Agent。
 * 错误反馈（toast）在函数内统一处理；选中身份由调用方 onAgentCreated 回调负责。
 */
export async function provisionBotAgent(input: ProvisionBotAgentInput): Promise<ProvisionBotAgentResult> {
  const t = i18n.t.bind(i18n)
  const organizationState = useOrganizationStore.getState()
  const organization = input.organizationId
    ? [
        organizationState.selectedOrganization,
        ...organizationState.organizations,
      ].find(item => item?.id === input.organizationId) ?? null
    : organizationState.selectedOrganization ?? organizationState.organizations[0] ?? null
  if (!organization) {
    toast({
      title: t('space:create.errors.organizationRequired', { defaultValue: '请先选择组织' }),
      variant: 'destructive',
    })
    return { ok: false }
  }

  try {
    const created = await createBotAgent({
      organizationId: organization.id,
      name: input.name,
      templateId: input.templateId,
      avatarKey: input.avatarKey,
    })

    input.onCreated?.()

    toast({
      title: t('space:agentCreate.success', { defaultValue: 'Agent 已就位' }),
    })

    return { ok: true, agent: created }
  } catch (error) {
    if (extractErrorCode(error) === AGENT_LIMIT_EXCEEDED_CODE) {
      toast({
        title: t('space:agentCreate.limitExceeded', { defaultValue: '智能体数量已达上限' }),
        variant: 'destructive',
      })
      return { ok: false }
    }
    log.error('开号失败', error)
    toast({
      title: t('space:agentCreate.failed', { defaultValue: '创建失败，请重试' }),
      description: error instanceof Error ? error.message : undefined,
      variant: 'destructive',
    })
    return { ok: false }
  }
}
