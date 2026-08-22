/**
 * ElectronAgentService — Electron 端通用 WS gateway 连接生命周期。
 *
 * 职责：
 *   1. 维持到 Backend WS 的连接（带 token 刷新与重试）
 * Agent topic、命令路由、观察流去重由 `@tabtin/agent-host` 统一拥有。
 */

import type { GatewayAuthContext } from '@tabtin/ws-gateway-client'
import { deviceTopicForDevice } from '@tabtin/agent-host/realtime'
import { app } from 'electron'
import { electronWsGateway } from '../ws/ElectronWsGateway.js'
import { TokenManager } from '../auth.js'
import {
  getCLIOrganizationId,
  onCLISpaceContextChanged,
} from '../cli/cli-server.js'
import { DAEMON_CONTROL_ENABLED } from '../config/api.js'
import { createLogger } from '../logger'
import {
  isDaemonControlEnabledForOrganization,
  registerCurrentElectronDevice,
} from './device-registration.js'
import { currentDeviceIdentity } from './device-identity/currentDeviceIdentity.js'

// 用统一主进程 logger 承接 agent-runtime 的 Logger 口子：打包版 info/warn/error
// 落 main.log，裸 console 会丢。所有既有 logger.* 调用点无需改动。
const logger = createLogger('ElectronAgent')

const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000
const RETRY_MAX_ATTEMPTS = 10

export class ElectronAgentService {
  private unsubscribers: Array<() => void> = []
  private started = false
  private connectionPromise: Promise<boolean> | null = null
  private connectionInFlight: { generation: number; promise: Promise<boolean> } | null = null
  private connectAbort: AbortController | null = null
  private retryAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private registrationRetryAttempt = 0
  private registrationRetryTimer: ReturnType<typeof setTimeout> | null = null
  private authGeneration = 0

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.retryAttempt = 0

    let activeOrganizationId = getCLIOrganizationId()
    this.unsubscribers.push(
      // 任何 auth 状态变化都替换网关认证。即使旧连接仍为 ready 也必须重建；
      // ready 只代表传输在线，不代表仍绑定当前用户或最新 token。
      TokenManager.onAuthChanged(() => {
        if (!this.started) return
        logger.info('Auth state changed — replacing gateway authentication')
        this.restartForAuthChange()
      }),
      onCLISpaceContextChanged(({ organizationId }) => {
        if (
          !this.started
          || !DAEMON_CONTROL_ENABLED
          || organizationId === activeOrganizationId
        ) return
        activeOrganizationId = organizationId
        logger.info('Organization changed — refreshing daemon-control activation')
        this.restartForAuthChange()
      }),
    )

    const generation = ++this.authGeneration
    this.startConnection(generation)

    logger.info('ElectronAgentService started — connecting in background')
  }

  private isCurrentAuth(generation: number): boolean {
    return this.started && generation === this.authGeneration
  }

  private restartForAuthChange(): void {
    const generation = ++this.authGeneration
    this.connectAbort?.abort()
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.clearRegistrationRetry()
    electronWsGateway.close()
    this.retryAttempt = 0
    this.startConnection(generation)
  }

  private clearRegistrationRetry(): void {
    if (this.registrationRetryTimer) {
      clearTimeout(this.registrationRetryTimer)
      this.registrationRetryTimer = null
    }
    this.registrationRetryAttempt = 0
  }

  private scheduleRegistrationRetry(generation: number): void {
    if (!DAEMON_CONTROL_ENABLED || !this.isCurrentAuth(generation) || this.registrationRetryTimer) return
    const delay = Math.min(
      RETRY_BASE_MS * Math.pow(1.5, this.registrationRetryAttempt),
      RETRY_MAX_MS,
    )
    this.registrationRetryAttempt++
    this.registrationRetryTimer = setTimeout(() => {
      this.registrationRetryTimer = null
      void this.retryDeviceRegistration(generation)
    }, delay)
    if (this.registrationRetryTimer.unref) this.registrationRetryTimer.unref()
  }

  private async retryDeviceRegistration(generation: number): Promise<void> {
    try {
      const token = await TokenManager.getAccessToken()
      if (!this.isCurrentAuth(generation)) return
      if (!token) {
        this.scheduleRegistrationRetry(generation)
        return
      }
      const registered = await registerCurrentElectronDevice(
        token,
        currentDeviceIdentity.getSnapshot().fingerprint,
      )
      if (!this.isCurrentAuth(generation)) return
      if (!registered) {
        this.scheduleRegistrationRetry(generation)
        return
      }

      this.clearRegistrationRetry()
      electronWsGateway.close()
      // 首次未登记时服务端会拒绝并移除设备 topic；登记成功后先恢复
      // desired topic，再复用同一 Gateway 连接完成重新鉴权与订阅。
      await electronWsGateway.subscribe([
        deviceTopicForDevice(electronWsGateway.getDeviceId()),
      ])
      if (!this.isCurrentAuth(generation)) return
      this.retryAttempt = 0
      this.startConnection(generation)
    } catch (error) {
      logger.warn(`Device registration recovery failed: ${error}`)
      this.scheduleRegistrationRetry(generation)
    }
  }

  private async connectAndSubscribe(generation: number): Promise<boolean> {
    const abort = new AbortController()
    this.connectAbort = abort
    try {
      const connected = await this.ensureGatewayConnected(generation, abort.signal)
      if (!connected || !this.isCurrentAuth(generation)) return false

      this.retryAttempt = 0
      logger.info('Background gateway connection complete')
      return true
    } catch (err) {
      logger.warn(`connectAndSubscribe failed: ${err}`)
      return false
    } finally {
      if (this.connectAbort === abort) this.connectAbort = null
    }
  }

  private async connectWithRetry(generation: number): Promise<boolean> {
    const ok = await this.connectAndSubscribe(generation)
    if (ok || !this.isCurrentAuth(generation)) return ok
    this.scheduleRetry(undefined, generation)
    return false
  }

  private startConnection(generation: number): Promise<boolean> {
    if (this.connectionInFlight?.generation === generation) {
      return this.connectionInFlight.promise
    }

    const promise = this.connectWithRetry(generation)
    const inFlight = { generation, promise }
    this.connectionInFlight = inFlight
    this.connectionPromise = promise
    const clear = () => {
      if (this.connectionInFlight === inFlight) this.connectionInFlight = null
    }
    void promise.then(clear, clear)
    return promise
  }

  private scheduleRetry(overrideDelayMs?: number, generation = this.authGeneration): void {
    if (!this.isCurrentAuth(generation)) return
    if (this.retryAttempt >= RETRY_MAX_ATTEMPTS) {
      logger.warn(`Gateway retry exhausted after ${RETRY_MAX_ATTEMPTS} attempts — waiting for auth event or resume`)
      return
    }
    if (this.retryTimer) clearTimeout(this.retryTimer)

    const delay = overrideDelayMs ?? Math.min(
      RETRY_BASE_MS * Math.pow(1.5, this.retryAttempt),
      RETRY_MAX_MS,
    )
    this.retryAttempt++
    logger.info(`Scheduling gateway retry #${this.retryAttempt} in ${Math.round(delay)}ms`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.isCurrentAuth(generation) || electronWsGateway.getStatus() === 'ready') return
      this.startConnection(generation)
    }, delay)
    if (this.retryTimer.unref) this.retryTimer.unref()
  }

  async ensureConnected(): Promise<boolean> {
    if (!this.connectionPromise) return false
    try {
      return await this.connectionPromise
    } catch {
      return false
    }
  }

  async retryConnect(): Promise<boolean> {
    if (!this.started) return false
    if (electronWsGateway.getStatus() === 'ready') return true
    if (this.connectionInFlight?.generation === this.authGeneration) {
      return this.connectionInFlight.promise
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retryAttempt = 0
    return this.startConnection(this.authGeneration)
  }

  async stop(): Promise<void> {
    this.started = false
    this.authGeneration++
    this.connectAbort?.abort()
    electronWsGateway.close()

    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.clearRegistrationRetry()
    for (const unsub of this.unsubscribers) {
      try { unsub() } catch { /* ignore */ }
    }
    this.unsubscribers = []

    if (this.connectionPromise) {
      try { await this.connectionPromise } catch { /* ignore */ }
      this.connectionPromise = null
    }

    logger.info('ElectronAgentService stopped')
  }

  private async ensureGatewayConnected(generation: number, abortSignal: AbortSignal): Promise<boolean> {
    if (electronWsGateway.getStatus() === 'ready') return true

    const token = await TokenManager.getAccessToken()
    if (!this.isCurrentAuth(generation)) return false
    if (!token) {
      logger.warn('Cannot connect WS gateway: no access token')
      return false
    }

    const organizationId = getCLIOrganizationId() ?? ''
    const daemonControlActive = DAEMON_CONTROL_ENABLED
      && await isDaemonControlEnabledForOrganization(token, organizationId)
    electronWsGateway.setDaemonControlActive(daemonControlActive)

    // 当前组织开启 daemon-control 时才登记；失败仅降级执行能力。
    const deviceRegistered = daemonControlActive
      ? await registerCurrentElectronDevice(
        token,
        currentDeviceIdentity.getSnapshot().fingerprint,
      )
      : false
    if (!this.isCurrentAuth(generation)) return false
    if (daemonControlActive && deviceRegistered) {
      // 上一轮未登记时 device topic 可能已被 WS client 从 desiredTopics
      // 剔除；成功登记后在 auth 前补回，首次安装与换账号都能恢复。
      await electronWsGateway.subscribe([
        deviceTopicForDevice(electronWsGateway.getDeviceId()),
      ])
      if (!this.isCurrentAuth(generation)) return false
    }

    // WS 连接绑用户不绑 organization：organization 只是前台 hint，
    // 没选也能直接连；服务端从 membership 自动选 primary。
    const initialHint = getCLIOrganizationId() ?? undefined
    if (!initialHint) {
      logger.info('No organization hint at connect time; proceeding without hint')
    }

    const t1 = performance.now()
    const MAX_RETRIES = 5
    let connected = false
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (!this.isCurrentAuth(generation)) break
      try {
        const freshToken = await TokenManager.getAccessToken()
        if (!this.isCurrentAuth(generation)) break
        if (!freshToken) { logger.warn('Token lost during connect'); break }
        const hint = getCLIOrganizationId() ?? initialHint
        const authCtx: GatewayAuthContext = hint
          ? { token: freshToken, organizationId: hint, device: { app_version: app.getVersion() } }
          : { token: freshToken, device: { app_version: app.getVersion() } }
        const result = await electronWsGateway.connect(authCtx)
        if (!this.isCurrentAuth(generation)) break
        if (result) {
          logger.info(
            `WS gateway connected (attempt ${attempt}, organizationHint=${hint ? hint.slice(0, 8) + '...' : 'none'})`,
          )
          if (daemonControlActive && deviceRegistered) {
            const resumed = await electronWsGateway.resumeDeviceActionsFromStart()
            if (!resumed.ok) {
              logger.warn(
                `Device action cold-start resume failed; buffered prompts remain recoverable: ${resumed.error?.message ?? resumed.type}`,
              )
            }
          }
          connected = true
          break
        }
        logger.warn(`WS gateway connect returned false (attempt ${attempt}, gwStatus=${electronWsGateway.getStatus()})`)
      } catch (err) {
        logger.warn(`WS gateway connect attempt ${attempt} threw: ${err}`)
      }
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(2000 * Math.pow(1.5, attempt - 1), 10_000)
        await new Promise<void>(r => {
          const timer = setTimeout(r, delay)
          if (abortSignal.aborted) {
            clearTimeout(timer); r(); return
          }
          abortSignal.addEventListener('abort', () => {
            clearTimeout(timer); r()
          }, { once: true })
        })
      }
    }
    logger.info(`Phase2:A3:wsConnect took ${(performance.now() - t1).toFixed(0)}ms`)

    if (!connected) {
      logger.warn('WS gateway connect failed — agent will not work until reconnect')
    } else if (this.isCurrentAuth(generation) && daemonControlActive && !deviceRegistered) {
      this.scheduleRegistrationRetry(generation)
    }
    return connected
  }

  pauseTimers(): void {
    logger.info('Timers paused (system suspend)')
  }

  resumeTimers(): void {
    if (!this.started) return
    if (electronWsGateway.getStatus() !== 'ready') {
      void this.retryConnect()
    }
    logger.info('Timers resumed (system resume)')
  }
}

export const electronAgentService = new ElectronAgentService()
