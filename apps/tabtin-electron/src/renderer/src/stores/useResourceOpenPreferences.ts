/** @store-category prefs */

/**
 * 资源打开偏好 store —— W4「Agent 产物在 Space 内的打开」专题
 *
 * 同一份内容（如 `tabtin://resource/document/...` / `https://...` /
 * `mailto:...`）可被多个 App 渲染。本 store 持有用户的两层选择，并按
 * `ResourceOpenPreferenceStore` 接口暴露给 `@tabtin/resource-router`：
 *
 *   - **第 1 层 user_pref**（持久化）：用户在个人设置页"默认应用"配置的"始终用
 *     X 打开"——按 pointerKey 维度（`type:<ContextRefType>` 或
 *     `scheme:<scheme>:`）映射到 carrier appId。多端同步是 mobile 单独专题
 *     的事（L16），本期 Electron 落 localStorage。
 *
 *   - **第 2 层 session_override**（仅内存）：用户在 chat 链接右键菜单点
 *     "用 X 打开"做的一次性切换——本会话内多次点击同一资源时记忆切换；
 *     退出 / 刷新后丢失。**不持久化**（避免"我只是临时换一下，下次还要"的体验
 *     反差）。
 *
 * 优先级裁决（D2 五层）由 `ResourceRouter.resolve` 严格执行——本 store 仅
 * 提供数据源（get/getSessionOverride），不参与排序。即使用户偏好里写的
 * carrier 当下不可用（如卸载该 App / 其 manifest opens 字段被改），router
 * 会自动降级到 manifest_default 而非系统应用（L19 行为约定）；store 这层
 * 不主动清理"已失效偏好"——保留写入意图，未来该 App 重装时偏好自动复活。
 *
 * 为何 zustand persist + localStorage：
 *   - 与 `useBrowserPrefsStore` / `useTaskNotificationPrefsStore` 等姊妹 store 一致
 *   - 本期 Electron-only，没有后端同步通路（mobile 专题届时再补）
 *   - localStorage 体积极小（typeof Record<string, string> 几 KB 上限），
 *     不需要 IndexedDB
 *
 * 为何不挂在 `useSpaceContextTabsStore` / `OrganizationSettingsPanel`：
 *   - 偏好是 **user-level**——切 space / 切 organization 不该丢（RFC §6.5）
 *
 * 为何不按 pointer.id 维度（如"始终用 X 打开 https://github.com/*"）：
 *   - 过度设计——AGENTS.md "抽象只在出现第二个使用场景时再加"。本期按
 *     type / scheme 维度即可（RFC §6.5）
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { withPersistSafety } from '@tabtin/shared'
import type { ResourceOpenPreferenceStore } from '@tabtin/resource-router'
import { PERSIST_KEYS } from './persist-key-registry'
import { markLocalChange, reconcileNamespace, scheduleNamespaceSave } from './uiSettingsSync'
import { registerResetAction } from './sessionResetRegistry'
import type { ResourceOpenPrefsPayload, UISettingsMap } from '@/types/uiSettings'

/**
 * 偏好 key 形态。与 router.preferenceKeyOf 共识：
 *   - 自有格式 + type 非空 → `'type:<ContextRefType>'`（如 `'type:document'`）
 *   - 行业格式 → `'scheme:<scheme>:'`（如 `'scheme:https:'`，注意尾冒号）
 */
export type ResourceOpenPrefKey = string

interface ResourceOpenPreferencesState {
  /**
   * 持久化偏好（D2 第 1 层 user_pref）。
   * key = ResourceOpenPrefKey，value = carrier appId（如 'tabdoc' / 'tabweb'）。
   * 系统应用兜底用约定字符串 `'__system__'`（与 `SYSTEM_CARRIER_APP_ID` 对齐）。
   */
  preferences: Record<ResourceOpenPrefKey, string>

  /**
   * 会话临时切换（D2 第 2 层 session_override）。
   * 用 plain object 而非 `Map` 是为了让 zustand reactivity 正常工作——
   * 改 Map 内部条目不会触发 selector 重渲染，要么换整个 Map 要么用 plain
   * object；后者更直观。**不进 partialize**，应用重启即丢。
   */
  sessionOverrides: Record<ResourceOpenPrefKey, string>

  /** 设置持久化偏好（"始终用 X 打开"）。 */
  setPreference(key: ResourceOpenPrefKey, carrierAppId: string): void
  /** 清除单条持久化偏好（用户在 settings Panel 点"重置"）。 */
  clearPreference(key: ResourceOpenPrefKey): void
  /** 清空所有持久化偏好（settings Panel 顶部按钮）。 */
  clearAllPreferences(): void

  /** 设置会话临时切换（"用 X 打开"——本会话内有效）。 */
  setSessionOverride(key: ResourceOpenPrefKey, carrierAppId: string): void
  /** 清除单条会话切换（用户改主意）。 */
  clearSessionOverride(key: ResourceOpenPrefKey): void
  /** 清空所有会话切换（极少用——一般退出应用自然丢失）。 */
  clearAllSessionOverrides(): void

  /** 读持久化偏好——给 router preferenceStore.get 用 */
  getPreference(key: ResourceOpenPrefKey): string | undefined
  /** 读会话切换——给 router preferenceStore.getSessionOverride 用 */
  getSessionOverride(key: ResourceOpenPrefKey): string | undefined

  // IA Phase 2 个人偏好同步（namespace = resourceOpenPrefs）。
  // 仅同步持久化偏好（user_pref），sessionOverrides 是会话语义不入同步。
  // 合并按整张映射 LWW（远端较新整体替换 / 本地较新推回）——保证"重置 / 清空"
  // 这类删除语义能正确跨设备传播（并集会让删除被另一端复活）。
  saveToServer(): void
  syncFromServer(remote: UISettingsMap): void
}

export const useResourceOpenPreferences = create<ResourceOpenPreferencesState>()(
  persist(
    (set, get) => ({
      preferences: {},
      sessionOverrides: {},

      setPreference: (key, carrierAppId) => {
        if (!key || !carrierAppId) return
        if (get().preferences[key] === carrierAppId) return
        set((state) => ({
          preferences: { ...state.preferences, [key]: carrierAppId },
        }))
        get().saveToServer()
      },
      clearPreference: (key) => {
        const before = get().preferences
        set((state) => {
          if (!(key in state.preferences)) return state
          const { [key]: _omit, ...rest } = state.preferences
          return { preferences: rest }
        })
        if (get().preferences !== before) get().saveToServer()
      },
      clearAllPreferences: () => {
        if (Object.keys(get().preferences).length === 0) return
        set({ preferences: {} })
        get().saveToServer()
      },

      setSessionOverride: (key, carrierAppId) => {
        if (!key || !carrierAppId) return
        set((state) => ({
          sessionOverrides: { ...state.sessionOverrides, [key]: carrierAppId },
        }))
      },
      clearSessionOverride: (key) => {
        set((state) => {
          if (!(key in state.sessionOverrides)) return state
          const { [key]: _omit, ...rest } = state.sessionOverrides
          return { sessionOverrides: rest }
        })
      },
      clearAllSessionOverrides: () => {
        set({ sessionOverrides: {} })
      },

      getPreference: (key) => get().preferences[key],
      getSessionOverride: (key) => get().sessionOverrides[key],

      // ── IA Phase 2 个人偏好同步（namespace = resourceOpenPrefs） ──
      saveToServer: () => {
        markLocalChange('resourceOpenPrefs')
        scheduleNamespaceSave('resourceOpenPrefs', () => get().preferences)
      },

      syncFromServer: (remote) => {
        reconcileNamespace<ResourceOpenPrefsPayload>({
          namespace: 'resourceOpenPrefs',
          remote: remote.resourceOpenPrefs,
          getLocalValue: () => get().preferences,
          applyRemoteValue: (value) => set({ preferences: { ...value } }),
          equals: (a, b) => {
            const aKeys = Object.keys(a)
            const bKeys = Object.keys(b)
            if (aKeys.length !== bKeys.length) return false
            return aKeys.every((k) => a[k] === b[k])
          },
          buildSaveValue: () => get().preferences,
        })
      },
    }),
    withPersistSafety<ResourceOpenPreferencesState, { preferences: Record<string, string> }>({
      name: PERSIST_KEYS.resourceOpenPreferences,
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // 故意只 persist preferences——sessionOverrides 是会话语义，重启即丢
      partialize: (state) => ({ preferences: state.preferences }),
      // v0 → v1：W4 首发版本，无前置数据；migrate 兜底原样返回
      migrate: (persisted, _version) => persisted as { preferences: Record<string, string> },
    }),
  ),
)

/**
 * 给 `ResourceRouter.deps.preferenceStore` 用的适配视图。
 *
 * 不直接把 store 当 ResourceOpenPreferenceStore——store 是 React hook，
 * router 的 deps 是普通 callback；中间套一层适配避免：
 *   1. router 在非 React 上下文（如 IPC fallback handler 异步分发）调用时
 *      触发 hook 内部的 useSyncExternalStore 报错
 *   2. set/unset 跟 store 字段名不一致时 silently broken
 *
 * 调用链：renderer 启动期 `wireResourceRouter({ preferenceStore: createPreferenceStoreAdapter() })`
 * 一次性注入；从此 router 内任何 resolve/open 都通过这个 adapter 读 store
 * 当前快照——zustand getState 是同步的，符合 router emit 的同步性约束。
 */
export function createResourceOpenPreferenceAdapter(): ResourceOpenPreferenceStore {
  return {
    get: (key) => useResourceOpenPreferences.getState().getPreference(key),
    set: (key, carrierAppId) =>
      useResourceOpenPreferences.getState().setPreference(key, carrierAppId),
    unset: (key) => useResourceOpenPreferences.getState().clearPreference(key),
    getSessionOverride: (key) =>
      useResourceOpenPreferences.getState().getSessionOverride(key),
  }
}

// ── IA Phase 2：登出/换账号时内存重置为默认 ──────────────────────────────
// 与 useUIStore / useVoiceSettingsStore 同款（详见 useUIStore 末尾注释）：
// resourceOpenPrefs 已接后端同步，登出只清 localStorage 会留下上个人的偏好映射在内存，
// 换人登录被"远端缺失→推本地"灌进新账号云端。这里把内存拉回默认（含会话临时覆盖），
// 与清 localStorage 对齐。
registerResetAction('resource-open-prefs-sync', 'reset', () => {
  useResourceOpenPreferences.setState({ preferences: {}, sessionOverrides: {} })
})
