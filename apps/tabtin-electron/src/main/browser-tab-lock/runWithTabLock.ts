import { lock, unlock } from './browserTabInputLock'
import { payloadHasUserInterventionWall } from './wallSignal'

export async function runWithTabLock<T>(
  tabId: string | undefined,
  run: () => Promise<T>,
  sessionId?: string,
): Promise<T> {
  if (tabId) lock(tabId, sessionId)

  try {
    const result = await run()
    if (tabId && payloadHasUserInterventionWall(result)) unlock(tabId)
    return result
  } catch (error) {
    if (tabId && payloadHasUserInterventionWall(error)) unlock(tabId)
    throw error
  }
}
