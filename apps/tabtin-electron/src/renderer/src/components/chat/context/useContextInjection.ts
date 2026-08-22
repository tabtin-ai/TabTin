/**
 * useContextInjection — 统一管理跨模块上下文引用
 *
 * 职责：
 * 1. 维护按 scope（session / draft）隔离的 pending context refs
 * 2. 提供 add / remove / clear 操作
 * 3. 转换为发送时的 blocks / context_refs
 * 4. 把 App 侧 emit 的全局注入事件桥接到当前活跃输入目标
 */

import { useCallback, useEffect } from 'react'
import { type ContextRef, type ContextRefType } from '../types'
import { encodeContextRefsToBlocks } from './contextRefCodec'
import { useContextInjectionStore, type ContextInjectPayload } from '@/stores/useContextInjectionStore'
import { deliverContextInjectToChat } from '@/services/deliverContextInjectToChat'

/** 全局事件名 */
export const CONTEXT_INJECT_EVENT = 'tabtin:inject-context-to-chat'

const EMPTY_REFS: ContextRef[] = []
let hasInstalledContextInjectionBridge = false

function installContextInjectionEventBridge(): void {
  if (hasInstalledContextInjectionBridge || typeof window === 'undefined') return

  window.addEventListener(CONTEXT_INJECT_EVENT, (event: Event) => {
    const detail = (event as CustomEvent<ContextInjectPayload>).detail
    if (!detail) return
    // 会话级投递：有 active scope 直写；无 active scope 路由到当前任务/草稿
    deliverContextInjectToChat(detail)
  })

  hasInstalledContextInjectionBridge = true
}

/** 触发全局上下文注入事件（从表格/文档模块调用） */
export function emitContextInject(payload: ContextInjectPayload): void {
  installContextInjectionEventBridge()
  window.dispatchEvent(
    new CustomEvent(CONTEXT_INJECT_EVENT, { detail: payload })
  )
}

export function useContextInjection(scopeId: string | null, enabled = true) {
  const contextRefs = useContextInjectionStore(
    useCallback(
      (state) => (scopeId ? state.contextRefsByScopeId[scopeId] ?? EMPTY_REFS : EMPTY_REFS),
      [scopeId],
    ),
  )
  const addRefToScope = useContextInjectionStore(s => s.addRefToScope)
  const addContextRefToScope = useContextInjectionStore(s => s.addContextRefToScope)
  const mergeRefsToScope = useContextInjectionStore(s => s.mergeRefsToScope)
  const removeRefFromScope = useContextInjectionStore(s => s.removeRefFromScope)
  const clearScope = useContextInjectionStore(s => s.clearScope)

  useEffect(() => {
    installContextInjectionEventBridge()
    if (!enabled || !scopeId) return

    useContextInjectionStore.getState().setActiveScope(scopeId)

    return () => {
      const store = useContextInjectionStore.getState()
      if (store.activeScopeId === scopeId) {
        store.setActiveScope(null)
      }
    }
  }, [enabled, scopeId])

  /** 添加引用 */
  const addRef = useCallback((ref: ContextRef) => {
    if (!scopeId) return
    addRefToScope(scopeId, ref)
  }, [addRefToScope, scopeId])

  /** 从 MentionItem / 全局事件创建并添加引用 */
  const addContextRef = useCallback(
    (
      type: ContextRefType,
      resourceId: string,
      label: string,
      extra?: Partial<ContextRef>
    ) => {
      if (!scopeId) return
      addContextRefToScope(scopeId, type, resourceId, label, extra)
    },
    [addContextRefToScope, scopeId]
  )

  /** 合并恢复 / 回填的引用 */
  const mergeRefs = useCallback((refs: ContextRef[]) => {
    if (!scopeId || refs.length === 0) return
    mergeRefsToScope(scopeId, refs)
  }, [mergeRefsToScope, scopeId])

  /** 移除引用 */
  const removeRef = useCallback((refId: string) => {
    if (!scopeId) return
    removeRefFromScope(scopeId, refId)
  }, [removeRefFromScope, scopeId])

  /** 清空所有引用 */
  const clearRefs = useCallback(() => {
    if (!scopeId) return
    clearScope(scopeId)
  }, [clearScope, scopeId])

  /** 将 contextRefs 转换为发送时的 blocks */
  const toBlocks = useCallback(
    (): Array<Record<string, unknown>> => contextRefsToBlocks(contextRefs),
    [contextRefs],
  )

  return {
    contextRefs,
    addRef,
    addContextRef,
    mergeRefs,
    removeRef,
    clearRefs,
    toBlocks,
    hasRefs: contextRefs.length > 0,
  }
}

/**
 * 将 ContextRef 数组转换为发送时的 message blocks。
 * 独立导出，供 ChatInput 等外部模块直接调用，避免重复实现转换逻辑。
 *
 * 注意 type 映射：
 * - 'table' → 'table_selection'（后端以有无 record_ids 判定整表引用）
 * - 'field' 保持原类型，避免被误解析成整表引用
 * - 'document' 保持整篇文档引用；只有显式选区才使用 'doc_selection'
 * - 其它（含新增的 webpage/memo/whiteboard/phone_device/desktop_device/terminal_session/tracker/agenda_event/web_annotation）→ 原样透传
 */
export function contextRefsToBlocks(refs: ContextRef[]): Array<Record<string, unknown>> {
  return encodeContextRefsToBlocks(refs)
}
