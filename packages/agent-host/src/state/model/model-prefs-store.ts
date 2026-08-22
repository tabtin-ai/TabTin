import type { ModelCatalogEntry } from '@tabtin/agent-runtime/engine'

export function modelCatalogScopeKey(owner: {
  userId: string
  organizationId: string
}): string {
  return `${owner.userId.trim()}:${owner.organizationId.trim()}`
}

/**
 * 模型运行态状态（ Phase 5 起步）。
 *
 * sessionContextTiers / sessionModelParamOverrides 是 per-session 偏好；模型目录
 * 是 host 生命周期内会变、按用户+Organization 分桶的模型状态，必须跟随
 * StateRoot，而不是散落在具体 host 私有字段里。
 */
export class ModelPrefsStore {
  readonly sessionContextTiers = new Map<string, string>()
  readonly sessionModelParamOverrides = new Map<
    string,
    Record<string, string | number | boolean | null>
  >()
  readonly catalogFallbackWarned = new Set<string>()

  /**
   * 模型目录同时受登录用户、Organization、成员档位和用户级 BYOK 影响，不能
   * 用进程全局单例。scopeKey 由宿主按 `userId:organizationId` 生成。
   */
  private readonly catalogSnapshotsByScope = new Map<string, ModelCatalogEntry[]>()

  getCatalogSnapshot(scopeKey: string): ModelCatalogEntry[] {
    return (this.catalogSnapshotsByScope.get(scopeKey) ?? []).slice()
  }

  replaceCatalogSnapshot(scopeKey: string, snapshot: readonly ModelCatalogEntry[]): void {
    this.catalogSnapshotsByScope.set(scopeKey, snapshot.slice())
    this.clearCatalogFallbackWarnings(scopeKey)
  }

  clearCatalogSnapshot(scopeKey: string): void {
    this.catalogSnapshotsByScope.delete(scopeKey)
    this.clearCatalogFallbackWarnings(scopeKey)
  }

  resetCatalog(): void {
    this.catalogSnapshotsByScope.clear()
    this.catalogFallbackWarned.clear()
  }

  /** @deprecated 测试兼容别名；生产代码请用 resetCatalog。 */
  resetCatalogForTesting(): void {
    this.resetCatalog()
  }

  private clearCatalogFallbackWarnings(scopeKey: string): void {
    const prefix = `${scopeKey}:`
    for (const key of this.catalogFallbackWarned) {
      if (key.startsWith(prefix)) this.catalogFallbackWarned.delete(key)
    }
  }
}
