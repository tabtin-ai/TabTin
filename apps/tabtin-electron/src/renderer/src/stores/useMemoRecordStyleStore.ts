/** @store-category domain */

/**
 * useMemoRecordStyleStore —— per-(user, organization) 记忆「记录风格」总开关的轻量缓存。
 *
 * 背景（TM-10 批 B · 记=用 / 方案一）：记忆开关已从 per-Agent
 * （agent_config.memory.enabled）统一到 per-(user, organization) 的 MemoRecordStyle
 * （后端权威 MemoryTableService.is_memory_enabled_for）。使用侧——local 注入
 * （sendMessageAction 热路径）、档案页记忆预览（ProfileModulePreviews）——需要一个
 * **同步可读**的 per-organization `enabled` 缓存，避免每次发消息都打 API。
 *
 * 真源：服务端 MemoRecordStyle.enabled（按 organization 分桶，user 由登录态隐含）。
 * 故归类 domain：跟随登录/切 organization 生命周期，登出时清空。
 *
 * 语义：
 *   - ensureLoaded(organizationId)：未缓存且未在飞时拉一次（organization 切换 / 预览挂载触发）。
 *   - setEnabled(organizationId, v)：本地直接写缓存（保存成功后乐观同步，省一次往返）。
 *   - isEnabled(organizationId)：同步读；**未加载默认 true**，与服务端"查无记录默认开"
 *     一致。注入是只读使用、fail-open 风险低（召回本身服务端另有权限校验）；
 *     这与写入侧 TM-4 的 fail-closed 不矛盾——写入怕误记，使用只是少召回。
 *   - reset()：登出 / 切用户时清空（sessionResetRegistry）。
 */
import { create } from 'zustand'
import { registerResetAction } from './sessionResetRegistry'
import { RecordStyleApi } from '@/services/recordStyleApi'

interface MemoRecordStyleState {
  /** per-organization record-style.enabled 缓存。缺键 = 未加载（isEnabled 走默认 true）。 */
  enabledByOrganization: Record<string, boolean>
  ensureLoaded: (organizationId: string | null | undefined) => Promise<void>
  isEnabled: (organizationId: string | null | undefined) => boolean
  setEnabled: (organizationId: string | null | undefined, enabled: boolean) => void
  reset: () => void
}

// 防重入：同一 organization 的并发 ensureLoaded 只打一次 API。timer/flag 不入 store
// state（不可序列化 + 生命周期独立）。
const _inflight = new Set<string>()

async function _fetchEnabled(organizationId: string): Promise<boolean> {
  const cfg = await RecordStyleApi.getRecordStyle(organizationId)
  return cfg.enabled
}

export const useMemoRecordStyleStore = create<MemoRecordStyleState>((set, get) => ({
  enabledByOrganization: {},

  ensureLoaded: async (organizationId) => {
    if (!organizationId) return
    if (organizationId in get().enabledByOrganization) return
    if (_inflight.has(organizationId)) return
    _inflight.add(organizationId)
    try {
      const enabled = await _fetchEnabled(organizationId)
      set((s) => ({ enabledByOrganization: { ...s.enabledByOrganization, [organizationId]: enabled } }))
    } catch {
      // fail-open：拉取失败不写缓存，isEnabled 继续走默认 true，不阻断发消息。
    } finally {
      _inflight.delete(organizationId)
    }
  },

  isEnabled: (organizationId) => {
    if (!organizationId) return true
    const cached = get().enabledByOrganization[organizationId]
    return cached ?? true
  },

  setEnabled: (organizationId, enabled) => {
    if (!organizationId) return
    set((s) => ({ enabledByOrganization: { ...s.enabledByOrganization, [organizationId]: enabled } }))
  },

  reset: () => {
    _inflight.clear()
    set({ enabledByOrganization: {} })
  },
}))

registerResetAction('memo-record-style', 'reset', () =>
  useMemoRecordStyleStore.getState().reset(),
)
