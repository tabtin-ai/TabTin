import { session } from 'electron'
import { AgentActionEvents } from '@tabtin/ws-gateway-client'
import { joinApiPath } from '@tabtin/config'
import { TokenManager } from '../auth.js'
import { getBrowserEnvironmentService } from '../browser-env/BrowserEnvironmentService.js'
import { getCLIContextSpaceBridge } from '../cli/cli-context.js'
import { API_BASE_URL } from '../config/api.js'
import { createLogger } from '../logger.js'
import { electronWsGateway } from '../ws/ElectronWsGateway.js'
import {
  matchesRelayDomain,
  normalizeRelayDomain,
  toCookiesSetDetails,
  type RelayCookie,
} from './cookie-scope.js'
import { refreshLoginRelayTab } from './refresh-tab.js'

const log = createLogger('LoginRelayImport')
const ACTION = 'login_relay.import'

type ActionResult = {
  success: boolean
  error?: string
  error_code?: LoginRelayImportErrorCode
  data?: { imported_count: number; reloaded?: boolean }
}

type LoginRelayImportErrorCode =
  | 'invalid_action'
  | 'consume_failed'
  | 'invalid_package'
  | 'domain_mismatch'
  | 'invalid_cookie'
  | 'partition_unavailable'
  | 'cookie_write_failed'
  | 'target_tab_unavailable'
  | 'target_tab_mismatch'
  | 'reload_failed'
  | 'import_failed'

class LoginRelayImportFailure extends Error {
  constructor(
    readonly errorCode: LoginRelayImportErrorCode,
    message: string,
  ) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : ''
}

function isSafeContextId(value: string): boolean {
  return value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value)
}

async function refreshOrRestoreLoginRelayTab(input: {
  tabId: string
  threadId: string
  spaceId: string
  expectedPartition: string
  expectedDomain: string
}) {
  const refreshInput = {
    tabId: input.tabId,
    expectedPartition: input.expectedPartition,
    expectedDomain: input.expectedDomain,
  }
  const initial = await refreshLoginRelayTab(refreshInput)
  if (initial.ok || initial.errorCode !== 'target_tab_unavailable') return initial

  const bridge = getCLIContextSpaceBridge()
  if (!bridge) return initial
  try {
    const restored = await bridge('set_active_context_tab', {
      _thread_id: input.threadId,
      spaceId: input.spaceId,
      tabKey: `tabweb:${input.tabId}`,
    })
    if (restored?.success !== true) return initial
  } catch (error) {
    log.warn('login relay target tab restore failed', { tabId: input.tabId }, error)
    return initial
  }
  return refreshLoginRelayTab(refreshInput)
}

async function consumeRelayPackage(packageId: string): Promise<unknown> {
  let token: string | null
  try {
    token = await TokenManager.getAccessToken()
  } catch {
    throw new LoginRelayImportFailure('consume_failed', 'Authentication is unavailable')
  }
  if (!token) throw new LoginRelayImportFailure('consume_failed', 'Authentication required')

  let response: Response
  try {
    response = await fetch(
      joinApiPath(
        API_BASE_URL,
        `/login-relay/packages/${encodeURIComponent(packageId)}/consume`,
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      },
    )
  } catch {
    throw new LoginRelayImportFailure('consume_failed', 'Login relay consume request failed')
  }
  if (!response.ok) {
    throw new LoginRelayImportFailure('consume_failed', `Login relay consume failed with HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new LoginRelayImportFailure('consume_failed', 'Login relay consume returned invalid JSON')
  }
}

function validateAndMapCookies(
  value: unknown,
  wallDomain: string,
): Electron.CookiesSetDetails[] {
  if (!Array.isArray(value)) {
    throw new LoginRelayImportFailure('invalid_cookie', 'Login relay package contains an invalid cookie')
  }

  const details: Electron.CookiesSetDetails[] = []
  const nowSeconds = Date.now() / 1_000
  for (const rawCookie of value) {
    if (!isRecord(rawCookie)) {
      throw new LoginRelayImportFailure('invalid_cookie', 'Login relay package contains an invalid cookie')
    }
    const cookie = rawCookie as unknown as RelayCookie
    if (
      typeof cookie.domain !== 'string'
      || !matchesRelayDomain(cookie.domain, wallDomain)
    ) {
      throw new LoginRelayImportFailure('invalid_cookie', 'Login relay package contains an invalid cookie')
    }

    if (
      typeof cookie.expirationDate === 'number'
      && Number.isFinite(cookie.expirationDate)
      && cookie.expirationDate <= nowSeconds
    ) {
      continue
    }
    const mapped = toCookiesSetDetails(cookie, nowSeconds)
    if (!mapped) {
      throw new LoginRelayImportFailure('invalid_cookie', 'Login relay package contains an invalid cookie')
    }
    details.push(mapped)
  }
  return details
}

async function sendResult(
  taskId: string,
  threadId: string,
  result: ActionResult,
): Promise<void> {
  try {
    const response = await electronWsGateway.requestWithLastAuth(
      AgentActionEvents.RESULT,
      { task_id: taskId, ...result },
      { threadId },
    )
    if (!response.ok) {
      log.error('login relay action result transport rejected', { taskId })
      throw new Error('Login relay action result transport failed')
    }
  } catch (error) {
    log.error('login relay action result transport failed', { taskId }, error)
    throw error
  }
}

export async function handleLoginRelayImportAction(
  payload: unknown,
  envelope?: unknown,
): Promise<boolean> {
  if (!isRecord(payload) || payload.action !== ACTION) return false

  const taskId = requiredString(payload.task_id)
  const envelopeRecord = isRecord(envelope) ? envelope : {}
  const threadId = requiredString(envelopeRecord.thread_id) || requiredString(payload.thread_id)
  const params = isRecord(payload.params) ? payload.params : {}
  const packageId = requiredString(params.package_id)
  const spaceId = requiredString(params.space_id)
  const organizationId = requiredString(params.organization_id)
  const domain = requiredString(params.domain)
  const tabId = requiredString(params.tab_id)

  if (
    !taskId
    || !threadId
    || !packageId
    || !spaceId
    || !organizationId
    || !isSafeContextId(organizationId)
    || !domain
    || !normalizeRelayDomain(domain)
    || (tabId && !isSafeContextId(tabId))
  ) {
    await sendResult(taskId, threadId, {
      success: false,
      error: 'Invalid login relay action payload',
      error_code: 'invalid_action',
    })
    return true
  }

  let result: ActionResult
  try {
    const consumed = await consumeRelayPackage(packageId)
    if (!isRecord(consumed)) {
      throw new LoginRelayImportFailure('invalid_package', 'Login relay consume returned an invalid package')
    }

    const consumedDomain = requiredString(consumed.domain)
    if (
      !consumedDomain
      || normalizeRelayDomain(consumedDomain) !== normalizeRelayDomain(domain)
    ) {
      throw new LoginRelayImportFailure('domain_mismatch', 'Login relay package domain mismatch')
    }

    // Validate and map the complete package before the first browser mutation.
    const cookieDetails = validateAndMapCookies(consumed.cookies, domain)
    let rawPartition: string
    try {
      rawPartition = getBrowserEnvironmentService().getPartitionForSpace(
        spaceId,
        organizationId,
      )
    } catch {
      throw new LoginRelayImportFailure('partition_unavailable', 'Browser partition is unavailable')
    }
    if (typeof rawPartition !== 'string' || !rawPartition) {
      throw new LoginRelayImportFailure('partition_unavailable', 'Browser partition is unavailable')
    }
    const partition = rawPartition.startsWith('persist:')
      ? rawPartition
      : `persist:${rawPartition}`
    const targetSession = session.fromPartition(partition)

    let importedCount = 0
    try {
      for (const details of cookieDetails) {
        await targetSession.cookies.set(details)
        importedCount++
      }
      if (!tabId) {
        result = {
          success: true,
          data: { imported_count: importedCount },
        }
      } else {
        const refreshed = await refreshOrRestoreLoginRelayTab({
          tabId,
          threadId,
          spaceId,
          expectedPartition: partition,
          expectedDomain: domain,
        })
        result = refreshed.ok
          ? {
              success: true,
              data: { imported_count: importedCount, reloaded: true },
            }
          : {
              success: false,
              error: 'Execution browser could not refresh the login page',
              error_code: refreshed.errorCode,
              data: { imported_count: importedCount },
            }
      }
    } catch {
      result = {
        success: false,
        error: 'Cookie import failed; partial writes may have occurred',
        error_code: 'cookie_write_failed',
        data: { imported_count: importedCount },
      }
    }
  } catch (error) {
    const failure = error instanceof LoginRelayImportFailure
      ? error
      : new LoginRelayImportFailure('import_failed', 'Login relay import failed')
    result = {
      success: false,
      error: failure.message,
      error_code: failure.errorCode,
    }
  }

  await sendResult(taskId, threadId, result)
  return true
}
