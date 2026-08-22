import { buildHideCursorScript } from '@tabtin/browser-core'
import { setOnViewsUnlocked } from './browserTabInputLock'

export function hideAgentCursorOnViews(
  viewIds: readonly string[],
  runScript: (script: string, viewId: string) => Promise<unknown>,
): void {
  if (viewIds.length === 0) return
  const script = buildHideCursorScript()
  for (const viewId of viewIds) {
    void Promise.resolve()
      .then(() => runScript(script, viewId))
      .catch(() => {})
  }
}

export function installAgentCursorLifecycle(): void {
  setOnViewsUnlocked((viewIds) => {
    hideAgentCursorOnViews(viewIds, async (script, viewId) => {
      const { executeScript } = await import('../crawl-view/content-ops')
      return executeScript(script, viewId)
    })
  })
}
