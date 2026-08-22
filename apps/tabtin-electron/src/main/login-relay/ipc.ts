import { randomUUID } from 'node:crypto'
import { app, session, type IpcMainInvokeEvent } from 'electron'
import { okResponse } from '@tabtin/agent-wire'
import { joinApiPath } from '@tabtin/config'
import { TokenManager } from '../auth'
import { API_BASE_URL } from '../config/api'
import {
  LoginRelaySessionManager,
  type LoginRelayCancelInput,
  type LoginRelayCompleteInput,
  type LoginRelayPackageResponse,
  type LoginRelaySessionDependencies,
  type LoginRelayStartInput,
  type ResolveWorkspaceOrganizationResult,
  type UploadPackageResult,
} from './relay-session'
import {
  DEFAULT_LOGIN_RELAY_UPLOAD_TIMEOUT_MS,
  LOGIN_RELAY_PROTOCOL_VERSION,
} from './timeout-contract'

type FetchLike = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json' | 'status'>>

export interface LoginRelayUploaderDependencies {
  apiBaseUrl: string
  getAccessToken: () => Promise<string | null>
  fetchFn: FetchLike
  timeoutMs?: number
}

export function createLoginRelayWorkspaceOrganizationResolver(
  dependencies: LoginRelayUploaderDependencies,
): LoginRelaySessionDependencies['resolveWorkspaceOrganization'] {
  return async (spaceId): Promise<ResolveWorkspaceOrganizationResult> => {
    const accessToken = await dependencies.getAccessToken()
    if (!accessToken) return { ok: false, error: '登录已失效，请重新登录' }

    let response: Pick<Response, 'ok' | 'json'>
    try {
      response = await dependencies.fetchFn(
        joinApiPath(
          dependencies.apiBaseUrl,
          `/context/workspaces/${encodeURIComponent(spaceId)}`,
        ),
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      )
    } catch {
      return { ok: false, error: '无法验证执行现场组织，请稍后重试' }
    }
    if (!response.ok) return { ok: false, error: '无法验证执行现场组织，请稍后重试' }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      return { ok: false, error: '执行现场组织响应无效' }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: '执行现场组织响应无效' }
    }
    const data = (parsed as Record<string, unknown>).data
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: '执行现场组织响应无效' }
    }
    const organizationId = (data as Record<string, unknown>).organization_id
    if (typeof organizationId !== 'string' || !organizationId) {
      return { ok: false, error: '执行现场组织响应无效' }
    }
    return { ok: true, organizationId }
  }
}

function isImportResult(value: unknown): value is LoginRelayPackageResponse['import_result'] {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return typeof result.success === 'boolean'
    && (result.imported_count === undefined
      || (Number.isInteger(result.imported_count) && Number(result.imported_count) >= 0))
    && (result.reloaded === undefined || typeof result.reloaded === 'boolean')
    && (result.error === undefined || typeof result.error === 'string')
}

function isPackageResponse(value: unknown): value is LoginRelayPackageResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Record<string, unknown>
  return typeof response.package_id === 'string'
    && response.package_id.length > 0
    && response.package_id.length <= 128
    && isImportResult(response.import_result)
}

export function createLoginRelayPackageUploader(
  dependencies: LoginRelayUploaderDependencies,
): LoginRelaySessionDependencies['uploadPackage'] {
  return async (body): Promise<UploadPackageResult> => {
    const accessToken = await dependencies.getAccessToken()
    if (!accessToken) return { ok: false, error: '登录已失效，请重新登录' }

    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      dependencies.timeoutMs ?? DEFAULT_LOGIN_RELAY_UPLOAD_TIMEOUT_MS,
    )
    try {
      const response = await dependencies.fetchFn(
        joinApiPath(dependencies.apiBaseUrl, '/login-relay/packages'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-TabTin-Login-Relay-Protocol-Version': LOGIN_RELAY_PROTOCOL_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      )
      if (!response.ok) {
        return {
          ok: false,
          error: response.status === 409
            ? '执行设备暂不可用，请确认执行设备在线后重试'
            : '服务暂时不可用，请重试',
        }
      }
      const parsed: unknown = await response.json()
      if (!isPackageResponse(parsed)) {
        return { ok: false, error: '服务响应无效，请重试' }
      }
      return { ok: true, data: parsed }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { ok: false, error: '服务响应超时，请重试' }
      }
      return { ok: false, error: '网络连接失败，请重试' }
    } finally {
      clearTimeout(timeout)
    }
  }
}

interface LoginRelayManagerPort {
  start(sender: IpcMainInvokeEvent['sender'], input: LoginRelayStartInput): Promise<unknown>
  complete(sender: IpcMainInvokeEvent['sender'], input: LoginRelayCompleteInput): Promise<unknown>
  cancel(sender: IpcMainInvokeEvent['sender'], input: LoginRelayCancelInput): Promise<unknown> | unknown
  dispose(): void
}

type LoginRelayHandler = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<unknown>

export function createLoginRelayHandlers(
  manager: LoginRelayManagerPort,
): Record<string, LoginRelayHandler> {
  return {
    'login-relay:start': async (event, input) =>
      okResponse(await manager.start(event.sender, input as LoginRelayStartInput)),
    'login-relay:complete': async (event, input) =>
      okResponse(await manager.complete(event.sender, input as LoginRelayCompleteInput)),
    'login-relay:cancel': async (event, input) =>
      okResponse(await manager.cancel(event.sender, input as LoginRelayCancelInput)),
  }
}

const loginRelayManager = new LoginRelaySessionManager({
  getSession: partition => session.fromPartition(partition),
  resolveWorkspaceOrganization: createLoginRelayWorkspaceOrganizationResolver({
    apiBaseUrl: API_BASE_URL,
    getAccessToken: () => TokenManager.getAccessToken(),
    fetchFn: (input, init) => fetch(input, init),
  }),
  uploadPackage: createLoginRelayPackageUploader({
    apiBaseUrl: API_BASE_URL,
    getAccessToken: () => TokenManager.getAccessToken(),
    fetchFn: (input, init) => fetch(input, init),
  }),
  generateRelayId: () => randomUUID(),
})

export const loginRelayHandlers = createLoginRelayHandlers(loginRelayManager)

let sideEffectsInitialized = false

export function initLoginRelaySideEffects(): void {
  if (sideEffectsInitialized) return
  sideEffectsInitialized = true
  app.once('before-quit', () => loginRelayManager.dispose())
}

export function disposeLoginRelaySessions(): void {
  loginRelayManager.dispose()
}
