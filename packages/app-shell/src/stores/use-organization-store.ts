/**
 * 组织状态管理 — 从 Electron 抽离
 *
 * 平台差异通过 runtime bridge 注入：
 * - resetChatClient → bridge.resetChatClient()
 * - window.tabtin.space.setActive → bridge.setActiveSpace()
 * - useAuthStore.user.id → auth.getCurrentUserId()
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { withPersistSafety } from '@tabtin/shared'
import type {
  Organization,
  OrganizationMember,
  CreateOrganizationRequest,
  UpdateOrganizationRequest,
  OrganizationRole,
  AssignableRole,
  OrganizationSearchParams,
} from '../types/organization.js'
import { OrganizationApiService } from '../services/organization-api.js'
import { MemberApiService } from '../services/member-api.js'
import { getRuntime } from '../runtime.js'
import { emitOrganizationSelected } from './organization-lifecycle-events.js'
import { normalizeOrganization, normalizeOrganizationList } from './organization/normalize.js'
import { extractErrorMessage, dedupAsync } from './organization/helpers.js'
import { createLogger } from '../utils/logger.js'
import { registerResetAction } from './session-reset-registry.js'
import {
  clearOrganizationSettingsKnown,
  notifyOrganizationSettingsKnown,
  resetFrontendContextReady,
} from './frontend-context-ready.js'
import {
  clearHostTurnOrganizationAllowMemberYolo,
  setHostTurnOrganizationAllowMemberYolo,
} from './host-turn-push.js'

const log = createLogger('Organization')

/** settings 权威已知后同步 frontend ready 与 Host turn 状态。 */
function syncOrganizationSettingsKnown(
  organization: Organization | null | undefined,
): void {
  if (!organization?.id) {
    notifyOrganizationSettingsKnown(null)
    clearHostTurnOrganizationAllowMemberYolo()
    return
  }
  notifyOrganizationSettingsKnown(organization)
  setHostTurnOrganizationAllowMemberYolo(
    organization?.settings?.allow_member_yolo === true,
  )
}

function clearOrganizationContextKnown(nextOrganizationId: string | null): void {
  clearOrganizationSettingsKnown(nextOrganizationId)
  clearHostTurnOrganizationAllowMemberYolo()
}

const organizationLoadPromises = new Map<string, Promise<void>>()
const memberLoadPromises = new Map<string, Promise<void>>()
let _rehydrateValidationTimer: ReturnType<typeof setTimeout> | null = null
let _organizationRetryTimer: ReturnType<typeof setTimeout> | null = null
let _selectSeq = 0

interface OrganizationSelectionSnapshot {
  selectedOrganization: Organization | null
  lastOpenedOrganizationId: string | null
  currentUserRole: OrganizationRole | null
  members: OrganizationMember[]
}

/**
 * 一串尚未确认的选择（A → B → C）都应回滚到最后已确认的 A，而非中间乐观态 B。
 * 这是模块运行态，登出/完整 reset 时清空，不参与持久化。
 */
let _selectionRollbackSnapshot: OrganizationSelectionSnapshot | null = null

/** TTL cache: skip re-fetching organization detail if selected within this window */
const SELECT_TTL_MS = 30_000
const _selectCache = new Map<string, number>()

export interface SelectOrganizationOptions {
  /**
   * @deprecated Wave 3 后切换 organization 不再触发 chat client reset；
   * 该字段保留仅为兼容调用方，不再有任何运行时语义。
   */
  skipChatReset?: boolean
  skipSpaceClear?: boolean
}

interface OrganizationState {
  organizations: Organization[]
  selectedOrganization: Organization | null
  /** 已发起但尚未完成前台 Space 切换的组织；运行态，不持久化。 */
  pendingOrganizationId: string | null
  lastOpenedOrganizationId: string | null
  currentUserRole: OrganizationRole | null
  members: OrganizationMember[]

  isLoadingList: boolean
  isSelecting: boolean
  isMutating: boolean
  isLoadingMembers: boolean
  isLoading: boolean
  error: string | null
  loadRetryCount: number
  lastLoadError: string | null

  loadOrganizations: (params?: OrganizationSearchParams) => Promise<void>
  selectOrganization: (organization: Organization | null, options?: SelectOrganizationOptions) => Promise<void>
  createOrganization: (data: CreateOrganizationRequest) => Promise<Organization>
  updateOrganization: (organizationId: string, data: UpdateOrganizationRequest) => Promise<Organization>
  applyOrganizationProfileUpdate: (patch: Partial<Organization> & { id: string }) => void
  deleteOrganization: (organizationId: string) => Promise<void>
  leaveOrganization: (organizationId: string) => Promise<void>
  transferOwnership: (organizationId: string, newOwnerUserId: string) => Promise<void>
  refreshOrganizationAccess: (organizationId: string) => Promise<void>

  loadMembers: (organizationId: string) => Promise<void>
  addMember: (organizationId: string, userId: string, role: AssignableRole) => Promise<void>
  updateMemberRole: (organizationId: string, userId: string, role: AssignableRole) => Promise<void>
  removeMember: (organizationId: string, userId: string) => Promise<void>

  getPersonalOrganization: () => Organization | null
  getTeamOrganizations: () => Organization[]
  isPersonalContext: () => boolean
  getDefaultOrganization: () => Promise<Organization | null>
  getEffectiveOrganization: () => Organization | null
  getEffectiveOrganizationId: () => string | null
  completeOrganizationContextSwitch: (organizationId: string | null) => void
  checkHealth: () => Promise<{ status: string; message: string }>
  clearSelection: () => void
  clearAll: () => void
}

type OrganizationPersistState = Pick<OrganizationState, 'organizations' | 'selectedOrganization' | 'lastOpenedOrganizationId' | 'currentUserRole'>

/**
 * 需要外部注入 clearSpaces 回调（由 useSpaceStore 提供），
 * 避免循环依赖。通过 setSpaceClearer 注册。
 */
let _clearSpaces: (() => void) | null = null
export function setSpaceClearer(fn: () => void): void {
  _clearSpaces = fn
}

/**
 * 读取当前前台 Space 的组织归属，供 pending 切换完成判定使用。
 * 通过注入避免 useOrganizationStore 与 useSpaceStore 循环依赖。
 */
let _getCurrentSpaceOrganizationId: (() => string | null) | null = null
export function setCurrentSpaceOrganizationIdResolver(fn: () => string | null): void {
  _getCurrentSpaceOrganizationId = fn
}

export const useOrganizationStore = create<OrganizationState>()(
  persist<OrganizationState, [], [], OrganizationPersistState>(
    (rawSet, get) => {
      const _set: typeof rawSet = (updater) => {
        rawSet((prev) => {
          const partial = typeof updater === 'function'
            ? (updater as (s: OrganizationState) => Partial<OrganizationState>)(prev)
            : updater as Partial<OrganizationState>
          const merged = { ...prev, ...partial }
          return {
            ...partial,
            isLoading: merged.isLoadingList || merged.isSelecting
              || merged.isMutating || merged.isLoadingMembers,
          }
        })
      }

      const removeAndFallback = async (
        organizationId: string,
        apiCall: () => Promise<void>,
        logKeys: { success: string; error: string },
      ) => {
        _set({ isMutating: true, error: null })
        try {
          await apiCall()
          const wasSelected = get().selectedOrganization?.id === organizationId
          const remaining = get().organizations.filter(w => w.id !== organizationId)
          _set(s => ({
            organizations: remaining,
            selectedOrganization: wasSelected ? null : s.selectedOrganization,
            members: wasSelected ? [] : s.members,
            isMutating: false,
          }))
          if (wasSelected) {
            syncOrganizationSettingsKnown(null)
          }
          log.info(logKeys.success)
          if (wasSelected) {
            const fallback = remaining.find(w => w.type === 'personal') ?? remaining.find(w => w.is_default) ?? remaining[0]
            if (fallback) {
              get().selectOrganization(fallback).catch(e => {
                log.warn('fallback select failed after remove:', e)
              })
            }
          }
        } catch (error) {
          const msg = extractErrorMessage(error, logKeys.error)
          log.error(logKeys.error, error)
          _set({ error: msg, isMutating: false })
          throw error
        }
      }

      return {
        organizations: [],
        selectedOrganization: null,
        pendingOrganizationId: null,
        lastOpenedOrganizationId: null,
        currentUserRole: null,
        members: [],
        isLoadingList: false,
        isSelecting: false,
        isMutating: false,
        isLoadingMembers: false,
        isLoading: false,
        error: null,
        loadRetryCount: 0,
        lastLoadError: null,

        loadOrganizations: async (params?) => {
          await dedupAsync(organizationLoadPromises, JSON.stringify(params || {}), async () => {
            _set({ isLoadingList: true, error: null })
            try {
              const response = await OrganizationApiService.getOrganizations(params)
              if (_organizationRetryTimer) {
                clearTimeout(_organizationRetryTimer)
                _organizationRetryTimer = null
              }
              _set({
                organizations: normalizeOrganizationList(response.organizations),
                isLoadingList: false,
                error: null,
                loadRetryCount: 0,
                lastLoadError: null,
              })
              log.info('Organization list loaded:', response.total)
            } catch (error) {
              const msg = extractErrorMessage(error, 'Failed to load organization list')
              log.error('Failed to load organization list:', error)

              if (_organizationRetryTimer) {
                clearTimeout(_organizationRetryTimer)
                _organizationRetryTimer = null
              }
              const retryCount = get().loadRetryCount + 1
              _set({ error: msg, isLoadingList: false, loadRetryCount: retryCount, lastLoadError: msg })
              if (retryCount <= 3) {
                const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 8000)
                log.info('Will retry loadOrganizations in %dms (attempt %d/3)', delay, retryCount)
                _organizationRetryTimer = setTimeout(() => {
                  _organizationRetryTimer = null
                  get().loadOrganizations(params)
                }, delay)
              }
            }
          })
        },

        selectOrganization: async (organization, options?) => {
          const mySeq = ++_selectSeq
          const current = get().selectedOrganization
          const wasSelecting = get().isSelecting
          const currentSelection: OrganizationSelectionSnapshot = {
            selectedOrganization: current,
            lastOpenedOrganizationId: get().lastOpenedOrganizationId,
            currentUserRole: get().currentUserRole,
            members: get().members,
          }
          const previousSelection = _selectionRollbackSnapshot ?? currentSelection
          if (!_selectionRollbackSnapshot) {
            _selectionRollbackSnapshot = currentSelection
          }
          let didOptimisticallySelect = false
          _set({
            isSelecting: true,
            error: null,
          })
          try {
            const bridge = getRuntime().bridge
            if (!organization) {
              if (mySeq !== _selectSeq) return
              // Wave 3: 清空 selectedOrganization 仅发生在登出链路（runAllResetActions 的
              // teardown 阶段会单独调用 resetChatClient）。切换流程下 organization 不会是 null，
              // 所以这里也不再调 bridge.resetChatClient()。
              if (!options?.skipSpaceClear) {
                _clearSpaces?.()
              }
              bridge.setActiveSpace(null, null, null)
              _set({
                selectedOrganization: null,
                pendingOrganizationId: null,
                lastOpenedOrganizationId: null,
                currentUserRole: null,
                members: [],
                isSelecting: false,
              })
              _selectionRollbackSnapshot = null
              syncOrganizationSettingsKnown(null)
              return
            }

            // 切到其他组织 / 首次进入：persist/列表 settings 不可信，先清 known。
            if (current?.id !== organization.id) {
              clearOrganizationContextKnown(organization.id)
            }

            // TTL cache: reuse existing data if same organization was loaded recently
            const cachedAt = _selectCache.get(organization.id)
            if (
              cachedAt
              && Date.now() - cachedAt < SELECT_TTL_MS
              && current?.id === organization.id
              && get().members.length > 0
            ) {
              _set({ isSelecting: false })
              _selectionRollbackSnapshot = null
              emitOrganizationSelected(organization.id)
              return
            }

            // Wave 3 修复 Y-3：optimistic 预设 selectedOrganization
            // ==========================================================
            // 切换 organization 是纯 UI 切换（Wave 3 WS 不断），用户期望"秒切"。
            // 原先每次 await getOrganization + getMembers 串行（300-1000ms），用户会
            // 明显感到卡顿。改为：
            //   1. 若传入的 organization 对象包含完整字段（通过了 normalizeOrganization），
            //      立即把它设为 selectedOrganization —— UI 能立即响应侧边栏激活态、
            //      useSpaceListLifecycle.handleOrganizationChange 能立刻做 selection
            //      切换；
            //   2. 异步 API 完成后再补 currentUserRole / members 并校正 organization
            //      detail（server 可能有 name/description 的更新）。
            //
            // 若 mySeq 在 optimistic 赋值和 API 完成之间被打断（快速切换到 C），
            // 则 API 回来时会被 mySeq !== _selectSeq 拦掉，不覆盖用户后来的选择。
            //
            // 注意：这里 optimistic 只在"传入 organization 为当前 organizations 列表的成员"
            // 时生效（避免拿到半成品 organization 对象；`loadOrganizations` 给的列表是
            // 经过 normalize 的完整对象，调用方从这里拿 organization 就是安全的）。
            const isKnownOrganization = get().organizations.some((w) => w.id === organization.id)
            const shouldOptimisticSet =
              isKnownOrganization && current?.id !== organization.id
            // 重复选择同一个尚未确认的目标时，current 已是乐观 B，但回滚基准仍是
            // A；后一次请求若失败也必须能恢复 A，而不能把 B 当作已确认状态。
            const shouldReusePendingRollback =
              isKnownOrganization
              && current?.id === organization.id
              && wasSelecting
              && get().pendingOrganizationId === organization.id
              && _selectionRollbackSnapshot?.selectedOrganization?.id !== organization.id
            if (shouldOptimisticSet || shouldReusePendingRollback) {
              didOptimisticallySelect = true
              if (shouldOptimisticSet) {
                _set({
                  selectedOrganization: organization,
                  pendingOrganizationId: organization.id,
                  lastOpenedOrganizationId: organization.id,
                  // 先清 members 避免 UI 展示旧 organization 的成员列表
                  members: [],
                  currentUserRole: null,
                })
                emitOrganizationSelected(organization.id)
              }
            }

            const [organizationDetailRaw, membersResponse] = await Promise.all([
              OrganizationApiService.getOrganization(organization.id),
              MemberApiService.getMembers(organization.id),
            ])

            if (mySeq !== _selectSeq) return

            const organizationDetail = normalizeOrganization(organizationDetailRaw)
            if (!organizationDetail) {
              throw new Error('Invalid organization detail')
            }

            const userId = getRuntime().auth.getCurrentUserId()
            let userRole: OrganizationRole | null = null
            if (userId) {
              if (organizationDetail.owner_id === userId) {
                userRole = 'owner'
              } else {
                const memberEntry = membersResponse.members.find(
                  (m: OrganizationMember) => m.user_id === userId,
                )
                userRole = (memberEntry?.role as OrganizationRole) ?? null
              }
            }

            // Wave 3: 切换 organization 是纯前端状态切换，WS 不动、聊天状态不清。
            // 仅在登出 / token 失效时才通过 sessionResetRegistry teardown 阶段
            // 调用 resetChatClient。
            //
            // API 返回后把 optimistic 预设的 organization 补全为服务端权威版本
            // （organizationDetail 带最新 name/description，members 完整）；
            // 同步写回 organizations[]，避免设置页仍读到列表旧快照。
            _set((s) => ({
              organizations: s.organizations.some((w) => w.id === organizationDetail.id)
                ? s.organizations.map((w) =>
                    w.id === organizationDetail.id ? organizationDetail : w,
                  )
                : [organizationDetail, ...s.organizations],
              selectedOrganization: organizationDetail,
              // 非乐观路径（如首次选择）到这里才把目标组织暴露给前台；需同步
              // 标记切换窗口。已切到目标但 Space 尚未就绪时，重复刷新详情不能
              // 提前清空 pending；只有 lifecycle 能结束前台切换窗口。
              pendingOrganizationId: shouldOptimisticSet || s.pendingOrganizationId === organizationDetail.id
                ? s.pendingOrganizationId
                : current?.id === organizationDetail.id
                  ? null
                  : organizationDetail.id,
              lastOpenedOrganizationId: organizationDetail.id,
              currentUserRole: userRole,
              members: membersResponse.members,
              isSelecting: false,
            }))
            _selectionRollbackSnapshot = null
            bridge.setActiveSpace(null, null, organizationDetail.id)

            _selectCache.set(organizationDetail.id, Date.now())
            // Y-3 优化：optimistic 路径已经 emit 过一次；未命中 optimistic 的场景
            // （第一次选 organization / 列表未加载完就点）仍需 emit 一次
            if (!shouldOptimisticSet) {
              emitOrganizationSelected(organizationDetail.id)
            }

            syncOrganizationSettingsKnown(organizationDetail)

            log.info('Organization selected:', organizationDetail.name)
          } catch (error) {
            if (mySeq !== _selectSeq) return
            const msg = extractErrorMessage(error, 'Failed to select organization')
            log.error('Failed to select organization:', error)
            if (didOptimisticallySelect) {
              _set({
                ...previousSelection,
                // 恢复 A 后旧 Space 可能仍停在 B；保持 A 为待切换目标，直到
                // lifecycle 已按 A 重编排前台 Space 后再清空。
                pendingOrganizationId: previousSelection.selectedOrganization?.id ?? null,
                error: msg,
                isSelecting: false,
              })
              _selectionRollbackSnapshot = null
              if (previousSelection.selectedOrganization) {
                syncOrganizationSettingsKnown(previousSelection.selectedOrganization)
                emitOrganizationSelected(previousSelection.selectedOrganization.id)
              } else {
                syncOrganizationSettingsKnown(null)
              }
              return
            }
            _selectionRollbackSnapshot = null
            _set({ error: msg, isSelecting: false })
            syncOrganizationSettingsKnown(get().selectedOrganization)
          }
        },

        createOrganization: async (data) => {
          _set({ isMutating: true, error: null })
          try {
            const newOrganization = normalizeOrganization(
              await OrganizationApiService.createOrganization(data),
            )
            if (!newOrganization) {
              throw new Error('Invalid created organization')
            }
            _set(s => ({
              organizations: [newOrganization, ...s.organizations],
              isMutating: false,
            }))
            await get().selectOrganization(newOrganization)
            log.info('Organization created:', newOrganization.name)
            return newOrganization
          } catch (error) {
            const msg = extractErrorMessage(error, 'Failed to create organization')
            log.error('Failed to create organization:', error)
            _set({ error: msg, isMutating: false })
            throw error
          }
        },

        updateOrganization: async (organizationId, data) => {
          _set({ isMutating: true, error: null })
          try {
            const updated = normalizeOrganization(
              await OrganizationApiService.updateOrganization(organizationId, data),
            )
            if (!updated) {
              throw new Error('Invalid updated organization')
            }
            _set(s => ({
              organizations: s.organizations.map(w => (w.id === organizationId ? updated : w)),
              selectedOrganization: s.selectedOrganization?.id === organizationId ? updated : s.selectedOrganization,
              isMutating: false,
            }))
            if (get().selectedOrganization?.id === organizationId) {
              syncOrganizationSettingsKnown(updated)
            }
            log.info('Organization updated:', updated.name)
            return updated
          } catch (error) {
            const msg = extractErrorMessage(error, 'Failed to update organization')
            log.error('Failed to update organization:', error)
            _set({ error: msg, isMutating: false })
            throw error
          }
        },

        applyOrganizationProfileUpdate: (patch) => {
          const organizationId = patch.id?.trim()
          if (!organizationId) return

          _set((state) => {
            if (!state.organizations.some((item) => item.id === organizationId)) {
              return state
            }

            const mergeOrganization = (existing: Organization): Organization => {
              return normalizeOrganization({ ...existing, ...patch }) ?? existing
            }

            return {
              organizations: state.organizations.map((item) =>
                item.id === organizationId ? mergeOrganization(item) : item,
              ),
              selectedOrganization:
                state.selectedOrganization?.id === organizationId
                  ? mergeOrganization(state.selectedOrganization)
                  : state.selectedOrganization,
            }
          })
          if (
            get().selectedOrganization?.id === organizationId
            && patch.settings !== undefined
          ) {
            syncOrganizationSettingsKnown(get().selectedOrganization)
          }
        },

        deleteOrganization: (organizationId) => removeAndFallback(
          organizationId,
          () => OrganizationApiService.deleteOrganization(organizationId),
          { success: 'Organization deleted', error: 'Failed to delete organization' },
        ),

        leaveOrganization: (organizationId) => removeAndFallback(
          organizationId,
          () => OrganizationApiService.leaveOrganization(organizationId),
          { success: 'Left organization', error: 'Failed to leave organization' },
        ),

        transferOwnership: async (organizationId, newOwnerUserId) => {
          if (get().isMutating) {
            throw new Error('Organization mutation already in progress')
          }

          const organization = get().organizations.find((item) => item.id === organizationId)
            ?? (get().selectedOrganization?.id === organizationId ? get().selectedOrganization : null)
          const previousOwnerId = organization?.owner_id

          _set({ isMutating: true, error: null })
          try {
            await OrganizationApiService.transferOwnership(organizationId, newOwnerUserId)
            const currentUserId = getRuntime().auth.getCurrentUserId()

            _set((state) => {
              const isSelected = state.selectedOrganization?.id === organizationId
              let currentUserRole = state.currentUserRole
              if (isSelected && currentUserId === newOwnerUserId) currentUserRole = 'owner'
              else if (isSelected && currentUserId === previousOwnerId) currentUserRole = 'editor'

              return {
                organizations: state.organizations.map((item) =>
                  item.id === organizationId ? { ...item, owner_id: newOwnerUserId } : item
                ),
                selectedOrganization: isSelected && state.selectedOrganization
                  ? { ...state.selectedOrganization, owner_id: newOwnerUserId }
                  : state.selectedOrganization,
                currentUserRole,
                members: isSelected
                  ? state.members.map((member) => {
                    if (member.user_id === newOwnerUserId) return { ...member, role: 'owner' as const }
                    if (member.user_id === previousOwnerId) return { ...member, role: 'editor' as const }
                    return member
                  })
                  : state.members,
                isMutating: false,
              }
            })
            log.info('Organization ownership transferred: organization=%s', organizationId)
          } catch (error) {
            const msg = extractErrorMessage(error, 'Failed to transfer organization ownership')
            log.error('Failed to transfer organization ownership:', error)
            _set({ error: msg, isMutating: false })
            throw error
          }
        },

        refreshOrganizationAccess: async (organizationId) => {
          // 服务端推送 `agent.user.permission.changed` 后的静默回读：所有权转让 /
          // 角色变更只改角色不改成员集合，`organization.membership_changed` 不会触发，
          // 若不主动回读，本 store 的 currentUserRole / owner_id 会一直陈旧（设置页
          // owner 门禁全部读这里）。
          //
          // 与 selectOrganization 的区别：纯数据刷新——不 emitOrganizationSelected、
          // 不碰 bridge.setActiveSpace，避免触发 space 列表生命周期等副作用。
          // 失败只记日志不写 error state（后台路径，行为退回"等下次全量刷新"）。
          const seqAtStart = _selectSeq
          try {
            if (get().selectedOrganization?.id !== organizationId) {
              // 非前台组织：只校正列表条目里的 owner_id 等字段；不在列表里说明
              // 本端还没加载过该组织（加入/移出走 membership_changed 通道），跳过。
              if (!get().organizations.some(w => w.id === organizationId)) return
              const detail = normalizeOrganization(
                await OrganizationApiService.getOrganization(organizationId),
              )
              if (!detail) return
              _set(s => ({
                organizations: s.organizations.map(w => (w.id === organizationId ? detail : w)),
              }))
              return
            }

            const [detailRaw, membersResponse] = await Promise.all([
              OrganizationApiService.getOrganization(organizationId),
              MemberApiService.getMembers(organizationId),
            ])
            // 回包途中用户切了组织：丢弃，绝不覆盖新选择（与 selectOrganization 同守卫）
            if (seqAtStart !== _selectSeq) return
            if (get().selectedOrganization?.id !== organizationId) return

            const detail = normalizeOrganization(detailRaw)
            if (!detail) return

            const userId = getRuntime().auth.getCurrentUserId()
            let userRole: OrganizationRole | null = null
            if (userId) {
              if (detail.owner_id === userId) {
                userRole = 'owner'
              } else {
                const memberEntry = membersResponse.members.find(
                  (m: OrganizationMember) => m.user_id === userId,
                )
                userRole = (memberEntry?.role as OrganizationRole) ?? null
              }
            }

            _set(s => ({
              organizations: s.organizations.map(w => (w.id === organizationId ? detail : w)),
              selectedOrganization: detail,
              currentUserRole: userRole,
              members: membersResponse.members,
            }))
            // 数据刚拉过，刷新 TTL，避免紧随其后的 selectOrganization 再打一轮 API
            _selectCache.set(organizationId, Date.now())
            syncOrganizationSettingsKnown(detail)
            log.info('Organization access refreshed: organization=%s role=%s', organizationId, userRole)
          } catch (error) {
            log.warn('Failed to refresh organization access (will rely on next full refresh):', error)
          }
        },

        loadMembers: async (organizationId) => {
          await dedupAsync(memberLoadPromises, organizationId, async () => {
            _set({ isLoadingMembers: true, error: null })
            try {
              const response = await MemberApiService.getMembers(organizationId)
              if (get().selectedOrganization?.id === organizationId) {
                _set({ members: response.members, isLoadingMembers: false })
              } else {
                _set({ isLoadingMembers: false })
              }
              log.info('Members loaded:', response.total)
            } catch (error) {
              const msg = extractErrorMessage(error, 'Failed to load members')
              log.error('Failed to load members:', error)
              _set({ error: msg, isLoadingMembers: false })
            }
          })
        },

        addMember: async (organizationId, userId, role) => {
          _set({ isLoadingMembers: true, error: null })
          try {
            await MemberApiService.addMember(organizationId, { user_id: userId, role })
            log.info('Member added')
            await get().loadMembers(organizationId)
          } catch (error) {
            const msg = extractErrorMessage(error, 'Failed to add member')
            log.error('Failed to add member:', error)
            _set({ error: msg, isLoadingMembers: false })
            throw error
          }
        },

        updateMemberRole: async (organizationId, userId, role) => {
          const originalMember = get().members.find(m => m.user_id === userId)
          _set(s => ({
            members: s.members.map(m => (m.user_id === userId ? { ...m, role } : m)),
          }))
          try {
            await MemberApiService.updateMemberRole(organizationId, userId, { role })
            log.info('Member role updated')
          } catch (error) {
            log.error('Failed to update member role:', error)
            if (originalMember) {
              _set(s => ({
                members: s.members.map(m => (m.user_id === userId ? originalMember : m)),
              }))
            }
            throw error
          }
        },

        removeMember: async (organizationId, userId) => {
          const seqAtStart = _selectSeq
          const isCurrentOrganization = () => (
            seqAtStart === _selectSeq
            && get().selectedOrganization?.id === organizationId
          )
          const removedMember = isCurrentOrganization()
            ? get().members.find(m => m.user_id === userId)
            : undefined
          if (removedMember) {
            _set(s => ({ members: s.members.filter(m => m.user_id !== userId) }))
          }
          try {
            await MemberApiService.removeMember(organizationId, userId)
            log.info('Member removed')
          } catch (error) {
            log.error('Failed to remove member:', error)
            try {
              const response = await MemberApiService.getMembers(organizationId)
              if (isCurrentOrganization()) {
                _set({ members: response.members })
              }
              if (!response.members.some(member => member.user_id === userId)) {
                log.info('Member removal confirmed after request error')
                return
              }
            } catch (reloadError) {
              log.warn('Failed to confirm member removal:', reloadError)
              if (removedMember && isCurrentOrganization()) {
                _set(s => ({
                  members: s.members.some(member => member.user_id === userId)
                    ? s.members
                    : [...s.members, removedMember],
                }))
              }
            }
            throw error
          }
        },

        getPersonalOrganization: () => {
          return get().organizations.find(w => w.type === 'personal') ?? null
        },

        getTeamOrganizations: () => {
          return get().organizations.filter(w => w.type === 'team')
        },

        isPersonalContext: () => {
          return get().selectedOrganization?.type === 'personal'
        },

        getDefaultOrganization: async () => {
          try {
            return normalizeOrganization(await OrganizationApiService.getDefaultOrganization())
          } catch (error) {
            log.error('Failed to get default organization:', error)
            return null
          }
        },

        getEffectiveOrganization: () => {
          const {
            pendingOrganizationId,
            selectedOrganization,
            lastOpenedOrganizationId,
            organizations,
          } = get()
          if (pendingOrganizationId) {
            const pendingOrganization = organizations.find(
              organization => organization.id === pendingOrganizationId,
            )
            if (pendingOrganization) return pendingOrganization
          }
          if (selectedOrganization) return selectedOrganization
          if (lastOpenedOrganizationId) {
            const lastOpened = organizations.find(w => w.id === lastOpenedOrganizationId)
            if (lastOpened) return lastOpened
          }
          return organizations.find(w => w.type === 'personal')
            ?? organizations.find(w => w.is_default)
            ?? organizations[0] ?? null
        },

        getEffectiveOrganizationId: () => get().getEffectiveOrganization()?.id ?? null,

        completeOrganizationContextSwitch: (organizationId) => {
          if (get().pendingOrganizationId !== organizationId) return
          const spaceOrganizationId = _getCurrentSpaceOrganizationId?.() ?? null
          if (spaceOrganizationId && spaceOrganizationId !== organizationId) return
          _set({ pendingOrganizationId: null })
        },

        checkHealth: async () => await OrganizationApiService.checkHealth(),

        clearSelection: () => {
          _selectionRollbackSnapshot = null
          _set({
            selectedOrganization: null,
            pendingOrganizationId: null,
            lastOpenedOrganizationId: null,
            currentUserRole: null,
            members: [],
          })
          syncOrganizationSettingsKnown(null)
        },

        clearAll: () => {
          const lastOpenedOrganizationId = get().lastOpenedOrganizationId
          if (_rehydrateValidationTimer) {
            clearTimeout(_rehydrateValidationTimer)
            _rehydrateValidationTimer = null
          }
          if (_organizationRetryTimer) {
            clearTimeout(_organizationRetryTimer)
            _organizationRetryTimer = null
          }
          ++_selectSeq
          organizationLoadPromises.clear()
          memberLoadPromises.clear()
          _selectCache.clear()
          _selectionRollbackSnapshot = null
          _set({
            organizations: [],
            selectedOrganization: null,
            pendingOrganizationId: null,
            lastOpenedOrganizationId,
            currentUserRole: null,
            members: [],
            isLoadingList: false,
            isSelecting: false,
            isMutating: false,
            isLoadingMembers: false,
            error: null,
            loadRetryCount: 0,
            lastLoadError: null,
          })
          syncOrganizationSettingsKnown(null)
          log.info('Organization data cleared')
        },
      }
    },
    withPersistSafety({
      name: 'tabtin-organization-store',
      partialize: (state) => ({
        organizations: state.organizations,
        selectedOrganization: state.selectedOrganization,
        lastOpenedOrganizationId: state.lastOpenedOrganizationId,
        currentUserRole: state.currentUserRole,
      }),
      version: 2,
      merge: (persisted: unknown, currentState: OrganizationState): OrganizationState => {
        const raw = (persisted || {}) as Record<string, unknown>
        const validRoles = new Set<string>(['owner', 'admin', 'editor', 'viewer'])
        const roleValue = raw.currentUserRole
        return {
          ...currentState,
          organizations: normalizeOrganizationList(raw.organizations),
          selectedOrganization: normalizeOrganization(raw.selectedOrganization),
          lastOpenedOrganizationId: typeof raw.lastOpenedOrganizationId === 'string'
            ? raw.lastOpenedOrganizationId
            : normalizeOrganization(raw.selectedOrganization)?.id ?? null,
          currentUserRole: (typeof roleValue === 'string' && validRoles.has(roleValue))
            ? roleValue as OrganizationRole
            : null,
        }
      },
      onRehydrateStorage: () => (state) => {
        // persist 快照的 settings 不可信：先清 known，等 selectOrganization DETAIL。
        if (state?.selectedOrganization?.id) {
          clearOrganizationContextKnown(state.selectedOrganization.id)
        } else {
          clearOrganizationContextKnown(null)
        }
        if (!state?.selectedOrganization?.id) return
        const organizationId = state.selectedOrganization.id
        const REHYDRATE_VALIDATION_DELAY_MS = 2000
        if (_rehydrateValidationTimer) clearTimeout(_rehydrateValidationTimer)
        _rehydrateValidationTimer = setTimeout(() => {
          _rehydrateValidationTimer = null
          OrganizationApiService.getOrganization(organizationId).catch((err: unknown) => {
            const raw = err as Record<string, unknown> | undefined
            const resp = raw?.response as Record<string, unknown> | undefined
            const status = resp?.status ?? raw?.status
            if (status === 404 || status === 403) {
              log.warn('Persisted organization invalid (%d), clearing selection', status)
              useOrganizationStore.setState({
                selectedOrganization: null,
                lastOpenedOrganizationId: null,
                currentUserRole: null,
                members: [],
              })
            }
          })
        }, REHYDRATE_VALIDATION_DELAY_MS)
      },
    }),
  ),
)

registerResetAction('organization', 'reset', () => useOrganizationStore.getState().clearAll())
registerResetAction('frontend-context-ready', 'reset', () => resetFrontendContextReady())
