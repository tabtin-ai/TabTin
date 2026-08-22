/**
 * judge-memo-store-adapter.ts — 把 InMemoryApprovalMemoStore（旧接口 ApprovalMemoStore）
 * 适配成 v3 MemoStore（@tabtin/security-policy）。
 *
 *  Stage 3b：自 agent-runtime 迁入宿主（security-policy 依赖留在 host）。
 */

import type {
  MemoStore,
  ApprovalMemoEntry as V3Entry,
  ApprovalMemoLookupResult,
} from '@tabtin/security-policy'
import { lookupMemo } from '@tabtin/security-policy'
import type {
  InMemoryApprovalMemoStore,
  ApprovalMemoEntry as OldEntry,
} from '@tabtin/agent-runtime'

function _oldToV3(old: OldEntry): V3Entry {
  const createdMs = typeof old.createdAt === 'number' ? old.createdAt : Date.now()
  const updatedMs = typeof old.updatedAt === 'number' ? old.updatedAt : createdMs
  const entry: V3Entry = {
    decision: old.decision,
    created_at: new Date(createdMs).toISOString(),
    updated_at: new Date(updatedMs).toISOString(),
    approver_user_id: old.approverUserId ?? '',
    scope_description: old.scope_description ?? '',
  }
  if (old.reason !== undefined) entry.reason = old.reason
  return entry
}

function _v3ToOld(v3: V3Entry): OldEntry {
  const created = new Date(v3.created_at).getTime()
  const updated = new Date(v3.updated_at).getTime()
  const entry: OldEntry = {
    decision: v3.decision,
    createdAt: isNaN(created) ? Date.now() : created,
    updatedAt: isNaN(updated) ? Date.now() : updated,
  }
  if (v3.approver_user_id) entry.approverUserId = v3.approver_user_id
  if (v3.reason !== undefined) entry.reason = v3.reason
  if (v3.scope_description) entry.scope_description = v3.scope_description
  return entry
}

/**
 * 把 InMemoryApprovalMemoStore 包装成 v3 MemoStore，让 judge 热路径 lookup() 命中记忆。
 */
export class JudgeMemoStoreAdapter implements MemoStore {
  constructor(private readonly _inner: InMemoryApprovalMemoStore) {}

  lookup(params: {
    toolName: string
    subcmd: string
    input: unknown
    inWorkspace: boolean
  }): ApprovalMemoLookupResult | null {
    const threadSnapshot = this._inner.__debugThreadSnapshot()
    const alwaysSnapshot = this._inner.__debugAlwaysSnapshot()
    const mergedSnapshot = { ...threadSnapshot, ...alwaysSnapshot }
    if (Object.keys(mergedSnapshot).length === 0) return null

    const v3Entries: Record<string, V3Entry> = {}
    for (const [key, entry] of Object.entries(mergedSnapshot)) {
      try {
        v3Entries[key] = _oldToV3(entry)
      } catch {
        // 格式异常的 entry 跳过
      }
    }

    return lookupMemo(
      v3Entries,
      params as Parameters<typeof lookupMemo>[1],
    )
  }

  async putAlways(key: string, entry: V3Entry): Promise<void> {
    this._inner.putAlways(key, _v3ToOld(entry))
  }

  async revoke(key: string): Promise<void> {
    const snapshot = this._inner.__debugAlwaysSnapshot()
    const { [key]: _removed, ...rest } = snapshot
    this._inner.replaceAll(rest, this._inner.generation)
  }

  get generation(): number {
    return this._inner.generation
  }

  async maybeRefetch(remoteGeneration: number): Promise<boolean> {
    return this._inner.maybeRefetch(remoteGeneration)
  }

  async bootstrap(): Promise<void> {
    await this._inner.bootstrap()
  }

  replaceAll(entries: Record<string, V3Entry>, generation: number): void {
    const oldEntries: Record<string, OldEntry> = {}
    for (const [key, entry] of Object.entries(entries)) {
      try {
        oldEntries[key] = _v3ToOld(entry)
      } catch {
        // 格式异常跳过
      }
    }
    this._inner.replaceAll(oldEntries, generation)
  }
}

export function createJudgeMemoStoreAdapter(
  inner: InMemoryApprovalMemoStore,
): JudgeMemoStoreAdapter {
  return new JudgeMemoStoreAdapter(inner)
}
