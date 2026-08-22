import type { Cookie, IpcMainInvokeEvent } from 'electron'
import { buildOrganizationBrowserPartition } from '../../shared/types/browser-env'
import {
  normalizeRelayTargetDomain,
  toRelayCookies,
  type RelayCookie,
} from './cookie-scope'

const MAX_CONTEXT_ID_LENGTH = 128
const MAX_THREAD_ID_LENGTH = 256
const MAX_RELAY_ATTEMPTS = 2

type RelayStatus = 'ready' | 'submitting' | 'closed'

export interface LoginRelayStartInput {
  spaceId: string
  organizationId: string
  domain: string
}

export interface LoginRelayCompleteInput {
  relayId: string
  threadId: string
  tabId?: string
}

export interface LoginRelayCancelInput {
  relayId: string
}

export interface LoginRelayImportResult {
  success: boolean
  imported_count?: number
  reloaded?: boolean
  error?: string
}

export interface LoginRelayPackageResponse {
  package_id: string
  import_result: LoginRelayImportResult
}

export interface LoginRelayResult {
  success: boolean
  relayId?: string
  partition?: string
  loginUrl?: string
  packageId?: string
  importResult?: LoginRelayImportResult
  error?: string
}

interface RelaySender {
  id: number
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

interface RelaySession {
  cookies: { get(filter: object): Promise<Cookie[]> }
}

interface UploadPackageInput {
  space_id: string
  thread_id: string
  domain: string
  tab_id?: string
  cookies: RelayCookie[]
}

export type UploadPackageResult =
  | { ok: true; data: LoginRelayPackageResponse }
  | { ok: false; error: string }

export type ResolveWorkspaceOrganizationResult =
  | { ok: true; organizationId: string }
  | { ok: false; error: string }

export interface LoginRelaySessionDependencies {
  getSession: (partition: string) => RelaySession
  resolveWorkspaceOrganization: (
    spaceId: string,
  ) => Promise<ResolveWorkspaceOrganizationResult>
  uploadPackage: (input: UploadPackageInput) => Promise<UploadPackageResult>
  generateRelayId: () => string
}

interface RelayState {
  relayId: string
  sender: RelaySender
  senderDestroyedHandler: () => void
  session: RelaySession
  spaceId: string
  domain: string
  status: RelayStatus
  attempts: number
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
}

function isSafeOrganizationId(value: unknown): value is string {
  return isBoundedText(value, MAX_CONTEXT_ID_LENGTH) && /^[A-Za-z0-9_-]+$/.test(value)
}

export class LoginRelaySessionManager {
  private readonly states = new Map<string, RelayState>()

  constructor(private readonly dependencies: LoginRelaySessionDependencies) {}

  async start(sender: RelaySender, input: LoginRelayStartInput): Promise<LoginRelayResult> {
    if (
      !isBoundedText(input?.spaceId, MAX_CONTEXT_ID_LENGTH)
      || !isSafeOrganizationId(input?.organizationId)
    ) {
      return { success: false, error: '登录接力上下文无效' }
    }
    const domain = normalizeRelayTargetDomain(input?.domain)
    if (!domain) return { success: false, error: '登录站点域名无效' }

    let workspaceContext: ResolveWorkspaceOrganizationResult
    try {
      workspaceContext = await this.dependencies.resolveWorkspaceOrganization(input.spaceId)
    } catch {
      return { success: false, error: '无法验证执行现场组织，请稍后重试' }
    }
    if (!workspaceContext.ok) return { success: false, error: workspaceContext.error }
    if (
      !isSafeOrganizationId(workspaceContext.organizationId)
      || workspaceContext.organizationId !== input.organizationId
    ) {
      return { success: false, error: '执行现场与当前组织不匹配' }
    }

    const relayId = this.dependencies.generateRelayId()
    const partition = `persist:${buildOrganizationBrowserPartition(workspaceContext.organizationId)}`
    const relaySession = this.dependencies.getSession(partition)

    const senderDestroyedHandler = (): void => {
      void this.closeState(relayId)
    }
    const state: RelayState = {
      relayId,
      sender,
      senderDestroyedHandler,
      session: relaySession,
      spaceId: input.spaceId,
      domain,
      status: 'ready',
      attempts: 0,
    }
    this.states.set(relayId, state)
    sender.once('destroyed', senderDestroyedHandler)

    return {
      success: true,
      relayId,
      partition,
      loginUrl: `https://${domain}/`,
    }
  }

  async complete(sender: RelaySender, input: LoginRelayCompleteInput): Promise<LoginRelayResult> {
    if (!isBoundedText(input?.relayId, MAX_CONTEXT_ID_LENGTH)) {
      return { success: false, error: '登录接力标识无效' }
    }
    if (!isBoundedText(input?.threadId, MAX_THREAD_ID_LENGTH)) {
      return { success: false, error: '对话标识无效' }
    }
    if (input.tabId !== undefined && !isBoundedText(input.tabId, MAX_CONTEXT_ID_LENGTH)) {
      return { success: false, error: '浏览器标签标识无效' }
    }
    const state = this.states.get(input.relayId)
    if (!state || state.status === 'closed') {
      return { success: false, error: '登录接力已结束' }
    }
    if (state.sender.id !== sender.id) {
      return { success: false, error: '无权操作该登录接力' }
    }
    if (state.status !== 'ready') {
      return { success: false, error: '登录态正在提交' }
    }

    state.status = 'submitting'
    try {
      const cookies = toRelayCookies(await state.session.cookies.get({}), state.domain)
      if (cookies.length === 0) {
        state.status = 'ready'
        return { success: false, error: '未检测到该站登录态，请先完成登录后重试' }
      }

      state.attempts += 1
      const uploaded = await this.dependencies.uploadPackage({
        space_id: state.spaceId,
        thread_id: input.threadId,
        domain: state.domain,
        ...(input.tabId ? { tab_id: input.tabId } : {}),
        cookies,
      })
      if (!uploaded.ok) {
        if (state.attempts >= MAX_RELAY_ATTEMPTS) await this.closeState(state.relayId)
        else state.status = 'ready'
        return { success: false, error: uploaded.error }
      }

      const response = uploaded.data
      await this.closeState(state.relayId)
      return {
        success: response.import_result.success,
        packageId: response.package_id,
        importResult: response.import_result,
        ...(response.import_result.success
          ? {}
          : { error: response.import_result.error || '登录态导入失败' }),
      }
    } catch {
      if (state.attempts >= MAX_RELAY_ATTEMPTS) await this.closeState(state.relayId)
      else state.status = 'ready'
      return { success: false, error: '登录态提交失败，请重试' }
    }
  }

  async cancel(sender: RelaySender, input: LoginRelayCancelInput): Promise<LoginRelayResult> {
    if (!isBoundedText(input?.relayId, MAX_CONTEXT_ID_LENGTH)) {
      return { success: false, error: '登录接力标识无效' }
    }
    const state = this.states.get(input.relayId)
    if (!state) return { success: true }
    if (state.sender.id !== sender.id) {
      return { success: false, error: '无权操作该登录接力' }
    }
    await this.closeState(input.relayId)
    return { success: true }
  }

  dispose(): void {
    for (const relayId of [...this.states.keys()]) void this.closeState(relayId)
  }

  private async closeState(relayId: string): Promise<void> {
    const state = this.states.get(relayId)
    if (!state || state.status === 'closed') return
    state.status = 'closed'
    this.states.delete(relayId)
    state.sender.removeListener('destroyed', state.senderDestroyedHandler)
  }
}

export type LoginRelayIpcSender = IpcMainInvokeEvent['sender']
