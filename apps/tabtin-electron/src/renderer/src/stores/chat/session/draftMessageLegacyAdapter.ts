/**
 *  legacy adapter：旧 store/API 宿主 id ↔ opaque draftScopeKey。
 *
 * 产品领域用 Organization / Workspace / Project + draftScopeKey。
 * 本文件是唯一允许接触 `draftSessionBySpaceId` / `currentSessionIdBySpaceId`
 * 及「用 legacy host 生成 draftScopeKey」的边界层。
 *
 * 禁止 import components/layout（避免 store→component→store cycle）。
 */

import {
  buildConversationDraftScopeKey,
  isConversationDraftScopeKey,
} from '@/lib/conversationDraftScopeKey'
import type { DraftMessageMetadata } from './draftMessage'
import type { DraftMessageSessionContext } from './draftMessageSessionCoordinator'

/** @legacy 旧 chat store 仍按 execution host id 索引 draft / session 指针 */
export interface LegacyDraftHostPointers {
  draftSessionBySpaceId: Record<string, boolean>
  currentSessionIdBySpaceId: Record<string, string | null>
}

/**
 * 解析 opaque draft scope：
 * - 主链显式 `stableDraftScopeKey`（产品宿主上的稳定新草稿 A）最高优先；
 *   有则禁止用 `conversation:S` / execution Workspace B 推导
 * - 其次已有 `conversation:draft:…`（如当前仍停在草稿欢迎态的 tabScopeKey）
 * - 否则 legacy 入口才用 host id 生成（模块不解析其结构）
 */
export function resolveConversationDraftScopeKey(input: {
  tabScopeKey?: string | null
  /**
   * 主链稳定 draft scope（由 ChatPanel 等从 Project / Workspace 产品宿主构造）。
   * 与当前会话 scope `conversation:S` 解耦；有值时不得 fallback execution B。
   */
  stableDraftScopeKey?: string | null
  /** @legacy 旧执行宿主 id（Workspace / 过渡期 Project host） */
  legacyExecutionHostId?: string | null
}): string | null {
  const stable = input.stableDraftScopeKey?.trim() || null
  if (stable && isConversationDraftScopeKey(stable)) {
    return stable
  }
  const tab = input.tabScopeKey?.trim() || null
  if (tab && isConversationDraftScopeKey(tab)) {
    return tab
  }
  // 主链已声明 stable 字段但非法 → fail-closed，禁止再猜 B
  if (input.stableDraftScopeKey != null && String(input.stableDraftScopeKey).trim() !== '') {
    return null
  }
  const host = input.legacyExecutionHostId?.trim() || null
  if (host) {
    return buildConversationDraftScopeKey(host)
  }
  return null
}

/**
 * 由产品宿主 id（Project / personal Workspace）构造稳定新草稿 scope。
 * 不得传入 execution Workspace B 或 session id。
 */
export function buildStableConversationDraftScopeKey(
  productHostId: string | null | undefined,
): string | null {
  const host = productHostId?.trim() || null
  if (!host) return null
  return buildConversationDraftScopeKey(host)
}

/** @legacy 欢迎态 UI 标记是否仍在 */
export function legacyIsUiDraft(
  legacyExecutionHostId: string | null | undefined,
  pointers: LegacyDraftHostPointers,
): boolean {
  if (!legacyExecutionHostId) return false
  return Boolean(pointers.draftSessionBySpaceId[legacyExecutionHostId])
}

/** @legacy 预建隐藏 session：draft 标记 + host 指针 */
export function legacyHiddenDraftSessionId(
  legacyExecutionHostId: string | null | undefined,
  pointers: LegacyDraftHostPointers,
): string | null {
  if (!legacyExecutionHostId) return null
  if (!pointers.draftSessionBySpaceId[legacyExecutionHostId]) return null
  return pointers.currentSessionIdBySpaceId[legacyExecutionHostId] ?? null
}

/** 组装 sync 上下文（调用方已持有 draftScopeKey） */
export function buildDraftMessageSessionContext(input: {
  draftScopeKey: string
  legacyExecutionHostId?: string | null
  pointers?: LegacyDraftHostPointers
  metadata?: DraftMessageMetadata
}): DraftMessageSessionContext {
  const host = input.legacyExecutionHostId ?? null
  const pointers = input.pointers ?? {
    draftSessionBySpaceId: {},
    currentSessionIdBySpaceId: {},
  }
  return {
    draftScopeKey: input.draftScopeKey,
    isUiDraft: legacyIsUiDraft(host, pointers),
    hiddenSessionId: legacyHiddenDraftSessionId(host, pointers),
    metadata: input.metadata,
  }
}

/**
 * 构建 draftMessage 元数据：仅写入调用方显式提供的真实 id。
 * 不得把 generic legacy host / team / project host 无条件冒充 executionWorkspaceId。
 */
export function buildDraftMessageMetadataFromLegacy(input: {
  organizationId?: string | null
  /** 仅当确认为真实执行 Workspace 资源 id 时传入 */
  executionWorkspaceId?: string | null
  /** 仅当确认为真实 Project 资源 id 时传入 */
  projectId?: string | null
  /** 调用边界注入的 Agent 快照 */
  agentId?: string | null
}): DraftMessageMetadata {
  return {
    organizationId: input.organizationId ?? undefined,
    executionWorkspaceId: input.executionWorkspaceId ?? undefined,
    projectId: input.projectId ?? undefined,
    agentId: input.agentId ?? undefined,
  }
}
