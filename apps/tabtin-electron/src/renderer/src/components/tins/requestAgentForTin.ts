/**
 * requestAgentForTin — 在 Tins 管理页把「创建 Tin」任务交给 Agent 的统一入口
 *
 * 触发场景：用户在 TinPanel / Tins 侧栏空态点击「让 Agent 创建 Tin」。
 *
 * 行为与 requestAgentForBrowser / requestAgentForTable 一致：
 *   1. 展开 ChatSidePanel（不切走画布——律 1「唤起不流放」，
 *      principle/workspace-project.md §7.2，；理由见 requestAgentForTable 文件头）
 *   2. 新建会话
 *   3. 直接发送预设 prompt
 */

import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useUIStore } from '@/stores/useUIStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('requestAgentForTin')

function notifyFailure(): void {
  toast({
    title: i18n.t('tins:empty.errorNoSession', {
      defaultValue: '暂时无法发起对话，请稍后再试',
    }),
    variant: 'destructive',
  })
}

export async function requestAgentForTin(spaceId: string, prompt?: string): Promise<void> {
  const body = (prompt ?? i18n.t('tins:empty.agentPrompt')).trim()
  if (!spaceId || !body) return

  useUIStore.getState().setChatSidePanelCollapsed(false)

  const organizationId = useOrganizationStore.getState().selectedOrganization?.id
  try {
    await useChatStore.getState().createSession(spaceId, organizationId)
  } catch (err) {
    log.warn('createSession for tin task failed', err)
    notifyFailure()
    return
  }

  const sessionId = useChatStore.getState().currentSessionId
  if (!sessionId) {
    log.warn('no session id after createSession for space %s', spaceId)
    notifyFailure()
    return
  }

  void useChatStore
    .getState()
    .sendMessage(body, true, undefined, undefined, sessionId)
    .catch(err => log.warn('sendMessage for tin task failed', err))
}
