/**
 * useTinsAgentHandler
 *
 * 全局 hook：监听 Tin 的 Agent 请求（runAgent / triggerGoal / writeToTable），
 * 在 ContentArea 中挂载，确保不随 TinPanel 的 tab 切换而卸载。
 *
 * W16-b：runAgent 改走本地 Runtime。老云端 chat HTTP endpoint 已下线；
 * 本 hook 现在为每次 runAgent 合成独立一次性 session，通过
 * `LocalAgentClient.stream()` 触发一次 LLM 推理，累积 assistant delta
 * 作为最终 reply 回传 sandbox。不污染用户当前会话、不走后端 session 表。
 */

import { useEffect, useRef } from 'react'
import { RecordApiService } from '@tabtin/table-core'
import { toast } from '@tabtin/smartsheet-ui'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useTinsStore } from '@stores/useTinsStore'
import { useAuthStore } from '@stores/useAuthStore'
import { triggerTask } from '../services/trackerApi'
import { invalidateTrackerAfterTrigger } from '../services/invalidateTrackerAfterTrigger'
import { getLocalAgentClient } from '../services/localAgentClient'
import { resolvePersonalRulesForRuntime } from '../services/personalRulesRuntimeCache'
import { createLogger } from '@/utils/logger'

const log = createLogger('Tins')

// W16-b: 每次 runAgent 合成一个一次性 sessionId。
// 与 chat session 的 UUID 不会冲突（chat 用 pure UUID，这里带 `tin-runagent-` 前缀）。
// 不走 client.sessions.create() / Django 后端建表——ElectronAgentHost 只用 sessionId
// 做内存态 runtime 缓存键，后端 relay_events 失败会降级为 `log.warn` 不阻塞 reply。
function makeOneShotSessionId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `tin-runagent-${uuid}`
}

function isLocalRuntimeReady(agentConfig?: { use_local_runtime?: boolean }): boolean {
  if (typeof window === 'undefined' || !window.tabtin?.agentEngine) return false
  if (agentConfig?.use_local_runtime === false) return false
  return true
}

async function runOneShotAgent(args: {
  instruction: string
  organizationId: string
}): Promise<{ reply?: string; error?: string }> {
  const { instruction, organizationId } = args

  const wsStore = useOrganizationStore.getState()
  const currentOrganizationId = wsStore.getEffectiveOrganizationId?.() || ''
  if (!organizationId || organizationId !== currentOrganizationId) {
    return {
      error: `Tin runAgent 被拒绝：organization 不匹配（event=${organizationId}, current=${currentOrganizationId || 'none'}）`,
    }
  }

  const spaceState = useSpaceStore.getState()
  const currentAgent = spaceState?.selectedAgent
  // PD-1（W6 M4）：authorization_preset 已删 —— 安全开关只读 security.allow_yolo_mode。
  // v3 PRD §5.1.1：字段改名 yolo_mode → allow_yolo_mode（Agent 级 gate）。
  const agentConfig = currentAgent?.agent_config as
    | { use_local_runtime?: boolean; security?: { allow_yolo_mode?: boolean } }
    | undefined

  if (!isLocalRuntimeReady(agentConfig)) {
    return {
      error:
        'Tin runAgent 不可用：当前 Agent 未绑定本地 Runtime。请先在 Agent 设置中绑定一台 Electron / Daemon 设备。',
    }
  }

  if (!currentAgent) {
    // 降级：没有选中 Agent 时，仍允许执行（主进程会走 DEFAULT_PERSONA），
    // 但要记录日志，方便后续定位"上下文缺失"的场景。
    log.warn('runAgent invoked without selectedAgent; falling back to defaults')
  }

  const localClient = getLocalAgentClient()
  const sessionId = makeOneShotSessionId()
  const capturedSpaceId = spaceState?.selectedSpace?.id ?? null
  const authUserId = useAuthStore.getState().user?.id
  const authOwnerKey = authUserId != null ? String(authUserId) : 'anonymous'
  const agentOwnerKey = currentAgent?.user_id != null ? String(currentAgent.user_id) : authOwnerKey
  const canFallbackToCurrentUserProfileRules =
    currentAgent?.user_id == null || String(currentAgent.user_id) === authOwnerKey

  let collected = ''

  try {
    const personalRulesForRuntime = await resolvePersonalRulesForRuntime(
      currentAgent,
      agentOwnerKey,
      { allowApiFallback: canFallbackToCurrentUserProfileRules },
    )

    await localClient.stream(
      sessionId,
      instruction,
      {
        onChunk: (delta: string) => {
          collected += delta
        },
        onMessage: () => {
          // 一次性调用不需要处理 HITL / tool 事件——Tin runAgent 默认走 agent 模式，
          // 工具集由 ElectronToolProvider + agent_config.security.allow_yolo_mode 决定；
          // 若模型产出 ask_user / review_required，本期按"尽力拿到文本回复"处理，
          // 拿不到就走 onError / 空 reply，不阻塞 sandbox。
        },
        onDone: () => {
          // 最终文本聚合已在 onChunk 里完成；这里无需额外动作。
        },
        onError: () => {
          // onError 会让 stream() 的 promise reject，统一在下方 catch 处理。
        },
      },
      {
        // W4.1（dogfood fix · review takeaway）：与 sendMessageAction 对称，
        // Tin runAgent 调本地 Runtime 时也必须透传 agentId——否则
        // ElectronAgentHost 装配 NativeBackendSession 时 if (agentId && ...)
        // 守卫整段 skip，Tin 用到的文件 / shell 工具同样会撞
        // "capability not bound to a BackendSession"。
        // currentAgent 已在 line 67 兜底（无 selectedAgent 时打 console.warn
        // 走 DEFAULT_PERSONA），id 缺失时主进程装配点 warn 也会兜底，可观察。
        agentId: currentAgent?.id,
        // ：IPC yoloMode 是"客户端声称值"（仅 telemetry；主进程从 Django 拉
        // 组织准入天花板作权威 gate）。gate 已从 Agent 级迁移到组织，这里透传当前
        // 组织的 allow_member_yolo 天花板。
        yoloMode: useOrganizationStore.getState().selectedOrganization?.settings?.allow_member_yolo === true,
        customRules: currentAgent?.custom_rules,
        // 分层规则·个人基线层（IA Phase 3 §8.6）：新后端由 Agent API 回传；
        // 旧后端缺字段时，当前用户自有 Agent 走个人规则接口兜底。
        personalRules: personalRulesForRuntime,
        agentMode: 'agent',
        appContext: capturedSpaceId ? { spaceId: capturedSpaceId } : undefined,
      },
    )

    const reply = collected.trim()
    if (!reply) {
      return { error: 'Tin runAgent 未产出任何内容' }
    }
    return { reply }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // 本地 Runtime 失败（LLM 异常 / 工具异常 / abort 等）——把错误交还 sandbox。
    return { error: `Tin runAgent 执行失败：${message}` }
  }
}

export function useTinsAgentHandler(): void {
  const spaceId = useSpaceStore((s) => s.selectedSpace?.id ?? null)
  const spaceIdRef = useRef(spaceId)
  spaceIdRef.current = spaceId

  useEffect(() => {
    const unsub = window.tabtin?.tins?.onAgentRequest(
      async (data: {
        requestId: string
        instruction: string
        organizationId: string
      }) => {
        if (!data?.requestId) return
        try {
          const result = await runOneShotAgent({
            instruction: data.instruction,
            organizationId: data.organizationId,
          })
          window.tabtin?.tins?.respondAgent(data.requestId, result)
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e)
          log.error('runAgent unexpected failure:', e)
          window.tabtin?.tins?.respondAgent(data.requestId, { error: errMsg })
        }
      },
    )
    return () => {
      unsub?.()
    }
  }, [])

  useEffect(() => {
    const unsubToast = window.tabtin?.tins?.onToast(
      (data: { message: string; type: string }) => {
        toast({
          title: data.message || '',
          variant: data.type === 'error' ? 'destructive' : undefined,
        })
      },
    )
    return () => {
      unsubToast?.()
    }
  }, [])

  useEffect(() => {
    // 历史命名遗留：Tin sandbox 内嵌应用通过 IPC `onTriggerGoal` + payload `goalId`
    // 与 Electron host 通信。它是 Tin sandbox 独立的 API wire format（不属于 Tracker
    // 模块），改名会破坏所有已发布的 Tin 应用；本期保留 sandbox API 字段名，
    // 接收后立即在内部把语义视为 trackerId（log / 调用都用 trackerId 语义）。
    const unsubTrigger = window.tabtin?.tins?.onTriggerGoal(
      async (data: { instanceId: string; goalId: string; params?: Record<string, unknown> }) => {
        const trackerId = data.goalId
        log.info(`triggerTracker – trackerId=${trackerId} instanceId=${data.instanceId}`)
        try {
          await triggerTask(trackerId, data.params)
          await invalidateTrackerAfterTrigger(trackerId)
        } catch (e) {
          log.error(`triggerTracker failed trackerId=${trackerId}:`, e)
          toast({ title: `Tracker trigger failed: ${e instanceof Error ? e.message : String(e)}`, variant: 'destructive' })
        }
      },
    )

    const unsubTable = window.tabtin?.tins?.onWriteTable(
      async (data: { instanceId: string; tableId: string; records: Record<string, unknown>[]; organizationId: string }) => {
        log.info(`writeToTable – tableId=${data.tableId} records=${data.records?.length ?? 0} organizationId=${data.organizationId}`)
        if (!Array.isArray(data.records) || data.records.length === 0) return

        const currentWsId = useOrganizationStore.getState().getEffectiveOrganizationId() || ''
        if (!data.organizationId || data.organizationId !== currentWsId) {
          log.error(`writeToTable blocked: organizationId mismatch (event=${data.organizationId}, current=${currentWsId})`)
          toast({ title: 'Write to table blocked: organization mismatch', variant: 'destructive' })
          return
        }

        try {
          for (const fields of data.records) {
            await RecordApiService.createRecord({
              table_id: data.tableId,
              fields,
              fieldKeyType: 'name',
            })
          }
        } catch (e) {
          log.error(`writeToTable failed tableId=${data.tableId}:`, e)
          toast({ title: `Write to table failed: ${e instanceof Error ? e.message : String(e)}`, variant: 'destructive' })
        }
      },
    )

    return () => {
      unsubTrigger?.()
      unsubTable?.()
    }
  }, [])
  // 引用避免未用变量（refactor 后 useTinsStore 已不再直接用，但保留 import 以防日后接入本地 Runtime）
  void useTinsStore
}
