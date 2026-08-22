import { isCloudDocsScopeKey } from '@/components/layout/cloudDocsDomain'
import {
  isDesktopScopeKey,
  isIsolatedScopeKey,
} from '@/components/layout/workspaceContextState'
import { getResourceCacheKey } from '@stores/useUnifiedResources'

/**
 * restore 资源 membership 应按标签 scope 取索引：
 * - desktop:* / cloud-docs:* / conversation:* / im:* → organization 桶（跨 Space / 组织级资源可见）
 * - 其它 → 执行 Space 桶
 *
 * 来自  / ：避免 desktop 工作台用 Space 索引把跨 Space 资源误判 stale。
 * ：云文档一级域列表同样是组织级视图；若仍读 Space 桶，打开 TabDoc/表格会被
 * 判 resource_missing，RestoreCoord 与 syncTabOrder 互掐把主线程卡死。
 * ：conversation / im 隔离桶同样常开组织级/分享文档；继续用 Space 索引会与
 * persistOnly 回补互掐（诊断包 RestoreCoord LOOP + 有序列表编号突变）。
 */
export function resolveRestoreResourceMembershipCacheKey(
  storageKey: string,
  spaceId: string,
): string {
  if (
    isDesktopScopeKey(storageKey)
    || isCloudDocsScopeKey(storageKey)
    || isIsolatedScopeKey(storageKey)
  ) {
    return getResourceCacheKey(spaceId, 'organization') ?? spaceId
  }
  return spaceId
}
