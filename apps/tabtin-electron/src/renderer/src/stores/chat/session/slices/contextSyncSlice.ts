/**
 * Context sync slice — syncContext.
 *
 * Extracted from useChatStore.ts. Handles Chat-mode context updates
 * (space, app type, open tabs).
 */

import { trackChatTelemetry } from '../../execution/chatTelemetry'
import {
  buildSendTimingPayload,
  getActiveSendTimingTrace,
} from '../../execution/sendTimingTrace'
import { buildContextSyncFingerprint } from '../../execution/contextSyncFingerprint'
import {
  registerInFlightContextSync,
} from '../../execution/contextSyncInFlight'
import { logger } from '@/utils/logger'
import { resolveDeviceTimeZone } from '@/utils/deviceTimeZone'
import { getSessionController } from '@/services/agentService'
import type { LocalAgentAppContext } from '../../../../services/localAgentClient'
import { resolveChatScopeHost } from '../utils/chatSessionScope'
import { useSessionAccessStore } from '../sessionAccessStore'

// ---------------------------------------------------------------------------
// Module-level cache: last synced app context per session
// ---------------------------------------------------------------------------

const _lastAppContext = new Map<string, LocalAgentAppContext>()

function resolveWorkspaceMode(scopeKey: string | null | undefined): LocalAgentAppContext['workspaceMode'] {
  if (scopeKey?.startsWith('conversation:')) return 'conversation'
  if (scopeKey?.startsWith('desktop:')) return 'desktop'
  return scopeKey ? 'non-space' : null
}

export function getLastAppContext(sessionId: string): LocalAgentAppContext | null {
  return _lastAppContext.get(sessionId) ?? null
}

export function clearAppContextCache(sessionId: string): void {
  _lastAppContext.delete(sessionId)
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface ContextSyncStore {
  currentSessionId: string | null
  lastContextSyncFingerprintBySessionId: Record<string, string>
}

type GetFn = () => ContextSyncStore
type SetFn = (
  partial:
    | Partial<ContextSyncStore>
    | ((state: ContextSyncStore) => Partial<ContextSyncStore>),
) => void

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ContextSyncDeps {
  getChatClient: () => { context: { update: (sessionId: string, payload: Record<string, unknown>) => Promise<unknown> } }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createContextSyncActions(
  get: GetFn,
  set: SetFn,
  deps: ContextSyncDeps,
) {
  const { getChatClient } = deps

  return {
    // 初始值归位到本 slice：最近一次成功同步的上下文指纹。
    lastContextSyncFingerprintBySessionId: {} as Record<string, string>,
    syncContext: async (
      spaceId?: string | null,
      appType?: string | null,
      appMeta?: Record<string, unknown> | null,
      openTabs?: Array<{
        type: string
        id: string
        title?: string
        active?: boolean
        group_id?: string
        // 2026-05-14：以下字段由 useChatPanelContext.openTabs 预解析填充——让
        // 下游 context-injector 不再做 type / appType case-switch（详见
        // useChatPanelContext.ts:resolveTab 注释）。
        app_key?: string          // 真正的 App 类型；apphome 时取 meta.appId
        display_name?: string     // Agent-facing 中文名，譬如 "多维表"
        is_home?: boolean         // 是否是该 App 的首页（resource list / launcher）
        // 兼容字段：
        app_home?: string         // apphome 兼容字段，同 app_key（is_home=true 时）
        path?: string
        kind?: string
        url?: string
        session_id?: string
      }> | null,
      options?: {
        force?: boolean
        deferHttpPersist?: boolean
        tabScopeKey?: string | null
        workspaceScopeKey?: string | null
        /** Programmatic flows can sync a non-active Project session explicitly. */
        targetSessionId?: string
      },
    ) => {
      const { currentSessionId: activeSessionId, lastContextSyncFingerprintBySessionId } = get()
      const currentSessionId = options?.targetSessionId ?? activeSessionId

      if (!currentSessionId) {
        return
      }

      try {
        // P1-7：视觉 Focus 只反映用户当前看见的工作面。
        // project_task 执行锚点由 Django 服务端权威注入；客户端不得在 chat focus
        // 时继续把 project_task 伪装成「当前看见的 App」，也不夹带陈旧资源 openTabs。
        const currentScopeKey = options?.tabScopeKey || options?.workspaceScopeKey || null
        const workspaceMode = resolveWorkspaceMode(currentScopeKey)
        const isChatVisualFocus = appType === 'chat'
        const effectiveAppType = appType
        const effectiveAppMeta = isChatVisualFocus ? null : appMeta
        const effectiveOpenTabs = isChatVisualFocus
          ? []
          : (Array.isArray(openTabs) ? openTabs : [])

        // 用户设备时区 —— 透传到 runtime 让 Agent 的 current_datetime 按用户本地
        // 渲染（而非 host 时区 / 裸 UTC）。Electron 走下方 appContext(IPC)，
        // daemon/云端走 contextPayload → Django 白名单 → wire payload。
        const userTimeZone = resolveDeviceTimeZone() ?? null

        const { currentProjectId } = resolveChatScopeHost(spaceId)
        const contextPayload: Record<string, unknown> = {
          // Project 是协作归属，不是资源宿主；不要再把它写进 current_space_id。
          current_space_id: currentProjectId ? null : (spaceId || null),
          current_project_id: currentProjectId,
          workspace_mode: workspaceMode,
          current_app_type: effectiveAppType || null,
          userTimeZone,
        }

        if (effectiveAppMeta) {
          Object.assign(contextPayload, effectiveAppMeta)
        }

        // open_tabs 必须始终显式带上（即使是空数组），否则后端 API 是「按 explicitly_set
        // 字段做 patch」语义，省略字段 = 保留旧值。用户关光所有 tab 时必须显式发 [] 才
        // 能让 Agent 看到「现在没有任何 tab」，否则它会一直引用上次残留的 open_tabs。
        contextPayload.open_tabs = effectiveOpenTabs

        const fingerprint = buildContextSyncFingerprint(currentSessionId, contextPayload)
        const previousFingerprint = lastContextSyncFingerprintBySessionId[currentSessionId]
        if (!options?.force && previousFingerprint === fingerprint) {
          const sendTiming = getActiveSendTimingTrace()
          trackChatTelemetry('context.sync.skipped.same_fingerprint', {
            sessionId: currentSessionId,
            phase: sendTiming ? 'pre_send' : 'background',
            ...buildSendTimingPayload(sendTiming),
          }, {
            counterKey: 'context.sync.skipped.same_fingerprint',
            sessionId: currentSessionId,
          })
          return
        }

        const sendTiming = getActiveSendTimingTrace()
        trackChatTelemetry('context.sync.start', {
          sessionId: currentSessionId,
          spaceId: spaceId,
          appType: effectiveAppType,
          openTabsCount: effectiveOpenTabs.length,
          phase: sendTiming ? 'pre_send' : 'background',
          ...buildSendTimingPayload(sendTiming),
        }, {
          counterKey: 'context.sync.start',
          sessionId: currentSessionId,
        })

        const appContext: LocalAgentAppContext = {
          spaceId: spaceId ?? null,
          workspaceMode,
          tabScopeKey: currentScopeKey,
          workspaceScopeKey: currentScopeKey,
          appType: effectiveAppType ?? null,
          appMeta: effectiveAppMeta ?? null,
          // 跟上面 contextPayload.open_tabs 同款语义：始终显式发数组（哪怕 []）。
          // 否则 IPC 这条线下游（main 进程 session.appContext + context-injector
          // hook）会一直显示「空 context」——space_id 之外什么都没有。
          openTabs: effectiveOpenTabs,
          userTimeZone,
        }
        _lastAppContext.set(currentSessionId, appContext)

        getSessionController(currentSessionId).pushContext(appContext)

        const commitFingerprint = () => {
          set(state => ({
            lastContextSyncFingerprintBySessionId: {
              ...state.lastContextSyncFingerprintBySessionId,
              [currentSessionId]: fingerprint,
            },
          }))
          trackChatTelemetry('context.sync.done', {
            sessionId: currentSessionId,
            spaceId: spaceId,
            appType: effectiveAppType,
            openTabsCount: effectiveOpenTabs.length,
            phase: sendTiming ? 'pre_send' : 'background',
            deferredHttp: Boolean(options?.deferHttpPersist),
            ...buildSendTimingPayload(sendTiming),
          }, {
            counterKey: 'context.sync.done',
            sessionId: currentSessionId,
          })
          logger.log('[Chat] Context synced:', {
            spaceId,
            appType: effectiveAppType,
            openTabs: effectiveOpenTabs.length,
          })
        }

        const sharedAccess = useSessionAccessStore.getState().bySessionId[currentSessionId]
        if (sharedAccess?.role === 'grantee') {
          commitFingerprint()
          trackChatTelemetry('context.sync.skipped.shared_grantee_http', {
            sessionId: currentSessionId,
            shareId: sharedAccess.shareId,
            spaceId: spaceId,
            appType: effectiveAppType,
            phase: sendTiming ? 'pre_send' : 'background',
            ...buildSendTimingPayload(sendTiming),
          }, {
            counterKey: 'context.sync.skipped.shared_grantee_http',
            sessionId: currentSessionId,
          })
          return
        }

        const client = getChatClient()
        if (options?.deferHttpPersist) {
          const httpTask = client.context.update(currentSessionId, contextPayload)
            .then(() => commitFingerprint())
            .catch((error: unknown) => {
              console.error('[Chat] Failed to sync context (deferred HTTP):', error)
              trackChatTelemetry('context.sync.failed', {
                sessionId: currentSessionId,
                spaceId: spaceId,
                appType,
                message: error instanceof Error ? error.message : String(error),
                phase: sendTiming ? 'pre_send' : 'background',
                deferredHttp: true,
                ...buildSendTimingPayload(sendTiming),
              }, {
                counterKey: 'context.sync.failed',
                level: 'error',
                sessionId: currentSessionId,
              })
            })
          registerInFlightContextSync(currentSessionId, httpTask)
          return
        }

        await client.context.update(currentSessionId, contextPayload)
        commitFingerprint()
      } catch (error) {
        console.error('[Chat] Failed to sync context:', error)
        trackChatTelemetry('context.sync.failed', {
          sessionId: currentSessionId,
          spaceId: spaceId,
          appType,
          message: error instanceof Error ? error.message : String(error),
          phase: getActiveSendTimingTrace() ? 'pre_send' : 'background',
          ...buildSendTimingPayload(getActiveSendTimingTrace()),
        }, {
          counterKey: 'context.sync.failed',
          level: 'error',
          sessionId: currentSessionId,
        })
      }
    },
  }
}
