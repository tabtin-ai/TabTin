/** @store-category session */

import { create } from 'zustand'
import type { ContextRef, ContextRefType } from '@/components/chat/types'
import { createContextRef } from '@/components/chat/types'
import { createLogger } from '@/utils/logger'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'

const log = createLogger('ContextInjectionStore')

export interface ContextInjectPayload {
  type: ContextRefType
  resourceId: string
  label: string
  spaceId?: string
  spaceName?: string
  meta?: Record<string, unknown>
  /** 可选：预览文本 */
  preview?: string
  /** 可选：来源 tab 类型（如 'tabweb' / 'tabdata'），由"添加到对话"入口填充 */
  tabType?: string
}

/**
 * 加入引用的结果信号（ 不变量 #4）——store 层只负责判定并返回拒绝原因，
 * toast / UI 反馈由调用方处理。
 */
export type ContextRefAddResult =
  | { ok: true }
  | { ok: false; reason: 'code_root_mismatch'; boundRootPath: string; attemptedRootPath: string }
  | { ok: false; reason: 'no_scope' }

interface ContextInjectionStoreState {
  activeScopeId: string | null
  contextRefsByScopeId: Record<string, ContextRef[]>
  setActiveScope: (scopeId: string | null) => void
  addRefToScope: (scopeId: string, ref: ContextRef) => ContextRefAddResult
  addContextRefToScope: (
    scopeId: string,
    type: ContextRefType,
    resourceId: string,
    label: string,
    extra?: Partial<ContextRef>,
  ) => ContextRefAddResult
  mergeRefsToScope: (scopeId: string, refs: ContextRef[]) => void
  removeRefFromScope: (scopeId: string, refId: string) => void
  clearScope: (scopeId: string) => void
  /** 定向写入指定 composer scope（与 active-scope 共用 payload→ref 转换 / 去重） */
  addInjectedPayloadToScope: (scopeId: string, payload: ContextInjectPayload) => ContextRefAddResult
  addInjectedPayloadToActiveScope: (payload: ContextInjectPayload) => ContextRefAddResult
  /**
   * 换根清理（ 不变量 #4）：切换会话代码根后，移除该 scope 内属于旧根的
   * 未发送 code_file / code_selection 引用；非代码引用保留。已发送的历史消息
   * 不回写，本 action 只影响 composer 里尚未发送的草稿引用。
   */
  pruneCodeRefsForRootChange: (scopeId: string, newRootPath: string) => void
}

function normalizeInjectedMeta(payload: ContextInjectPayload): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {
    ...(payload.meta ?? {}),
  }
  if (typeof payload.preview === 'string' && payload.preview.trim()) {
    meta.preview = payload.preview
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

function contextInjectPayloadToRef(payload: ContextInjectPayload): ContextRef {
  return createContextRef(payload.type, payload.resourceId, payload.label, {
    spaceId: payload.spaceId,
    spaceName: payload.spaceName,
    tabType: payload.tabType,
    meta: normalizeInjectedMeta(payload),
  })
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function buildContextRefIdentity(ref: ContextRef): string {
  const meta = ref.meta ?? {}

  switch (ref.type) {
    case 'field':
      return JSON.stringify([ref.type, ref.resourceId, { tableId: meta.tableId ?? null }])
    case 'table_selection':
      return JSON.stringify([
        ref.type,
        ref.resourceId,
        {
          record_ids: meta.record_ids ?? null,
          field_ids: meta.field_ids ?? null,
          preview: meta.preview ?? null,
        },
      ])
    case 'doc_selection':
      return JSON.stringify([
        ref.type,
        ref.resourceId,
        {
          block_ids: meta.block_ids ?? null,
          full_text: meta.full_text ?? null,
          preview: meta.preview ?? null,
        },
      ])
    case 'code_file':
      return JSON.stringify([
        ref.type,
        ref.resourceId,
        {
          filePath: meta.filePath ?? null,
          rootPath: meta.rootPath ?? null,
        },
      ])
    case 'code_selection':
      return JSON.stringify([
        ref.type,
        ref.resourceId,
        {
          filePath: meta.filePath ?? null,
          rootPath: meta.rootPath ?? null,
          startLine: meta.startLine ?? null,
          endLine: meta.endLine ?? null,
          preview: meta.preview ?? null,
        },
      ])
    case 'web_selection':
      return JSON.stringify([
        ref.type,
        ref.resourceId,
        {
          url: meta.url ?? null,
          pageTitle: meta.pageTitle ?? null,
          preview: meta.preview ?? null,
        },
      ])
    case 'web_annotation':
      {
        const dom = getRecord(meta.dom)
        const selection = getRecord(meta.selection)
        const rect = getRecord(meta.rect)
        const stableDomKey = dom?.selector ?? dom?.xpath ?? dom?.tag ?? null
        const selectionKind = selection?.kind ?? null
        const selectionText = selectionKind === 'text' ? selection?.text ?? meta.preview ?? null : null
        const textRect = selectionKind === 'text' && rect
          ? [rect.x ?? null, rect.y ?? null, rect.width ?? null, rect.height ?? null]
          : null
        const stableAnnotationKey = meta.annotationKey ?? (
          stableDomKey
            ? JSON.stringify([meta.url ?? ref.resourceId, selectionKind, stableDomKey, selectionText, textRect])
            : meta.annotationId ?? null
        )
        return JSON.stringify([
          ref.type,
          ref.resourceId,
          {
            annotationKey: stableAnnotationKey,
            url: meta.url ?? null,
          },
        ])
      }
    case 'webpage':
    case 'memo':
    case 'whiteboard':
    case 'phone_device':
    case 'desktop_device':
    case 'terminal_session':
    case 'tracker':
    case 'agenda_event':
      // 整个 tab 资源引用：仅按 type + resourceId 去重，避免同一资源重复添加
      return JSON.stringify([ref.type, ref.resourceId])
    default:
      return JSON.stringify([ref.type, ref.resourceId])
  }
}

function upsertContextRef(existing: ContextRef[], incoming: ContextRef): ContextRef[] {
  const incomingIdentity = buildContextRefIdentity(incoming)
  const matchIndex = existing.findIndex(ref => buildContextRefIdentity(ref) === incomingIdentity)

  if (matchIndex >= 0) {
    const next = existing.slice()
    next[matchIndex] = {
      ...incoming,
      // 复用已有 id，避免同一 chip 因 metadata 更新而闪烁重建
      id: existing[matchIndex].id,
    }
    return next
  }

  return [...existing, incoming]
}

function mergeContextRefs(existing: ContextRef[], refs: ContextRef[]): ContextRef[] {
  return refs.reduce((acc, ref) => upsertContextRef(acc, ref), existing)
}

function isCodeRef(ref: ContextRef): boolean {
  return ref.type === 'code_file' || ref.type === 'code_selection'
}

function refRootPath(ref: ContextRef): string {
  const value = ref.meta?.rootPath
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 同一 scope 内允许同根多个代码文件；拒绝加入 rootPath 与当前会话代码根不同
 * 的新代码引用（ 不变量 #4）。只读显式绑定（peer store，不经 chat/utils
 * resolver、不带 spaceWorkingDir 兜底）——未绑定时不限制，因为还没有"哪个根
 * 是对的"这个概念；code ref 缺 rootPath（历史数据 / 外部来源）时同样不拦，
 * 交给调用方自行判断。
 */
function checkCodeRootGuard(scopeId: string, ref: ContextRef): ContextRefAddResult {
  if (!isCodeRef(ref)) return { ok: true }
  const attemptedRootPath = refRootPath(ref)
  if (!attemptedRootPath) return { ok: true }
  const binding = useSessionBoundCodeRootStore.getState().getBinding(scopeId)
  const boundRootPath =
    binding?.status === 'active' && binding.rootPath.trim()
      ? binding.rootPath
      : null
  if (!boundRootPath || boundRootPath === attemptedRootPath) return { ok: true }
  return { ok: false, reason: 'code_root_mismatch', boundRootPath, attemptedRootPath }
}

export const useContextInjectionStore = create<ContextInjectionStoreState>((set, get) => ({
  activeScopeId: null,
  contextRefsByScopeId: {},

  setActiveScope: (scopeId) => {
    set({ activeScopeId: scopeId })
  },

  addRefToScope: (scopeId, ref) => {
    const guardResult = checkCodeRootGuard(scopeId, ref)
    if (!guardResult.ok) {
      log.warn('addRefToScope rejected: code root mismatch', {
        scopeId,
        refType: ref.type,
        boundRootPath: guardResult.reason === 'code_root_mismatch' ? guardResult.boundRootPath : undefined,
        attemptedRootPath: guardResult.reason === 'code_root_mismatch' ? guardResult.attemptedRootPath : undefined,
      })
      return guardResult
    }
    set((state) => ({
      contextRefsByScopeId: {
        ...state.contextRefsByScopeId,
        [scopeId]: upsertContextRef(state.contextRefsByScopeId[scopeId] ?? [], ref),
      },
    }))
    return { ok: true }
  },

  addContextRefToScope: (scopeId, type, resourceId, label, extra) => {
    const ref = createContextRef(type, resourceId, label, extra)
    return get().addRefToScope(scopeId, ref)
  },

  mergeRefsToScope: (scopeId, refs) => {
    if (refs.length === 0) return
    set((state) => ({
      contextRefsByScopeId: {
        ...state.contextRefsByScopeId,
        [scopeId]: mergeContextRefs(state.contextRefsByScopeId[scopeId] ?? [], refs),
      },
    }))
  },

  removeRefFromScope: (scopeId, refId) => {
    set((state) => ({
      contextRefsByScopeId: {
        ...state.contextRefsByScopeId,
        [scopeId]: (state.contextRefsByScopeId[scopeId] ?? []).filter(ref => ref.id !== refId),
      },
    }))
  },

  clearScope: (scopeId) => {
    set((state) => ({
      contextRefsByScopeId: {
        ...state.contextRefsByScopeId,
        [scopeId]: [],
      },
    }))
  },

  addInjectedPayloadToScope: (scopeId, payload) => {
    if (!scopeId) return { ok: false, reason: 'no_scope' }
    return get().addRefToScope(scopeId, contextInjectPayloadToRef(payload))
  },

  addInjectedPayloadToActiveScope: (payload) => {
    const scopeId = get().activeScopeId
    if (!scopeId) {
      // 裸写 active scope 在 ChatPanel 卸载后会静默丢弃；跨 App 投递请走
      // deliverContextInjectToChat / emitContextInject。
      log.warn('addInjectedPayloadToActiveScope skipped: no active scope', {
        type: payload.type,
        labelLength: payload.label?.length ?? 0,
      })
      return { ok: false, reason: 'no_scope' }
    }
    return get().addInjectedPayloadToScope(scopeId, payload)
  },

  pruneCodeRefsForRootChange: (scopeId, newRootPath) => {
    set((state) => {
      const existing = state.contextRefsByScopeId[scopeId]
      if (!existing || existing.length === 0) return state
      const pruned = existing.filter((ref) => {
        if (!isCodeRef(ref)) return true
        const rootPath = refRootPath(ref)
        if (!rootPath) return true
        return rootPath === newRootPath
      })
      if (pruned.length === existing.length) return state
      log.info('pruneCodeRefsForRootChange removed stale code refs', {
        scopeId,
        newRootPath,
        removedCount: existing.length - pruned.length,
      })
      return {
        contextRefsByScopeId: {
          ...state.contextRefsByScopeId,
          [scopeId]: pruned,
        },
      }
    })
  },
}))
