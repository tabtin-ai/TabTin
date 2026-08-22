import type { ResourceMonitorTabScope } from './model'

export interface CloseTabScopesResult {
  succeeded: number
  failed: number
  fullyClosedScopeKeys: string[]
}

export async function closeResourceMonitorTabScopes(
  scopes: ResourceMonitorTabScope[],
  closeTab: (input: {
    spaceId: string
    tabScopeKey: string
    tabKey: string
  }) => Promise<{ success: boolean }>,
): Promise<CloseTabScopesResult> {
  let succeeded = 0
  let failed = 0
  const fullyClosedScopeKeys: string[] = []

  for (const scope of scopes) {
    let scopeFailed = false
    for (const tabKey of scope.tabKeys) {
      try {
        const result = await closeTab({
          spaceId: scope.spaceId,
          tabScopeKey: scope.scopeKey,
          tabKey,
        })
        if (result.success) succeeded += 1
        else {
          failed += 1
          scopeFailed = true
        }
      } catch {
        failed += 1
        scopeFailed = true
      }
    }
    if (!scopeFailed && scope.tabKeys.length > 0) fullyClosedScopeKeys.push(scope.scopeKey)
  }

  return { succeeded, failed, fullyClosedScopeKeys }
}
