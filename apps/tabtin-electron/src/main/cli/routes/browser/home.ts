import http from 'node:http'
import type { SendJSON } from './_helpers'
import {
  buildBrowserRequestScope,
  handleRouteError,
  requireBridgeAndSpace,
  sendExecutorResult,
} from './_helpers'

const BROWSER_HOME_TIMEOUT_MS = 15_000

/** Electron-only browser entry action; Renderer resolves custom URL vs TabWeb workspace. */
export async function handleBrowserHomeRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {
  if (route !== '/home') return false

  const context = requireBridgeAndSpace(body, res, sendJSON)
  if (!context) return true

  try {
    const result = await context.bridge('open_browser_home', {
      ...buildBrowserRequestScope(body),
      spaceId: context.spaceId,
    }, BROWSER_HOME_TIMEOUT_MS)
    sendExecutorResult(result, res, sendJSON)
  } catch (error) {
    handleRouteError(error, sendJSON, res)
  }
  return true
}
