/** @store-category domain */

/**
 * Device Store — 设备状态管理（执行设备 + 能力设备）
 *
 * 负责：
 * - Electron 启动时将自身注册到后端（registerCurrentDevice）
 * - 维护设备列表和当前设备信息
 * - 创建 Space 时自动附带 device_fingerprint
 * - 通过 WS 监听设备上线/下线事件，实时更新状态
 */

import { create } from 'zustand'
import { DomainEvents } from '@tabtin/ws-gateway-client'
import { Device, DeviceListResponse } from '@tabtin/app-shell'
import { DeviceApiService } from '@/services/deviceApi'
import { getOrCreateDeviceId, getSyncedDeviceIdentity } from '@/utils/deviceId'
import { logger } from '@/utils/logger'
import { getAuthToken } from '@/adapters/api-adapter-instance'
import { getChatClient } from '@/services/chatApi'
import { isOrganizationPermissionMessage, recoverFromInvalidOrganizationAccess } from '@/services/membershipEventHandler'
import { useSpaceStore } from './useSpaceStore'
import { useAuthStore } from './useAuthStore'
import { useOrganizationStore } from './useOrganizationStore'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { registerResetAction } from './sessionResetRegistry'
import { emitDeviceStatusMessage } from './deviceStatusEvents'
import { onOrganizationSelected as onOrganizationSelected } from './organizationLifecycleEvents'
import { collectCurrentHostRuntimeSnapshot } from '@/services/runtimeSnapshot'
import { createSleepAwareInterval, type SleepAwareInterval } from '@/utils/sleepAwareInterval'
import { dedupAsync } from '@/stores/organization/helpers'
import i18n from '@/i18n'

const HEARTBEAT_INTERVAL_MS = 60_000

const ELECTRON_CAPABILITIES = [
  'terminal_execute',
  'terminal_read',
  'terminal_write',
  'browser',
  'file',
  'gui',
  'mcp',
  'git',
  'code_search',
]

/**
 * DV-2：绑定设备「假离线」自愈宽限（秒）。
 *
 * 后端休眠/巡检误判后，设备常在 ~60s 内心跳恢复。若 offline 立刻往对话注入
 * 持久 ⚠️ 横幅，紧接 ✅ online 会污染主对话。宽限内只 toast；仍离线才写对话；
 * 宽限内恢复则取消 pending，对话零噪声。
 */
const BOUND_DEVICE_OFFLINE_CHAT_GRACE_MS = 90_000

/** 宽限计时器：到期才把 offline 写入对话。 */
let _boundDeviceOfflineChatTimer: ReturnType<typeof setTimeout> | null = null
/** 本轮 offline 是否已把 offline 横幅写入对话（online 时仅此时才补 emitOnline）。 */
let _boundDeviceOfflineChatEmitted = false

function _clearBoundDeviceOfflineChatGrace(): void {
  if (_boundDeviceOfflineChatTimer) {
    clearTimeout(_boundDeviceOfflineChatTimer)
    _boundDeviceOfflineChatTimer = null
  }
}

/** 测试 / clearDevices 重置模块级宽限状态。 */
export function _resetBoundDeviceOfflineChatGraceForTests(): void {
  _clearBoundDeviceOfflineChatGrace()
  _boundDeviceOfflineChatEmitted = false
}

function _notifyBoundDeviceStatusChange(payload: DeviceStatusPayload): void {
  const agent = useSpaceStore.getState().selectedAgent
  const boundDeviceId = agent?.control_device_id ?? agent?.bound_device_id
  if (!boundDeviceId || boundDeviceId !== payload.device_id) return

  const n = { name: payload.name }
  if (payload.status === 'offline') {
    _clearBoundDeviceOfflineChatGrace()
    _boundDeviceOfflineChatEmitted = false
    toast({
      title: i18n.t('space:device.toastOfflineTitle', n),
      description: i18n.t('space:device.toastOfflineDesc'),
      variant: 'destructive',
    })
    // 宽限后再写对话——假离线（DV-2）多在 60s 内自愈，避免 ⚠️+✅ 永久噪声。
    const offlineText = i18n.t('space:device.emitOffline', n)
    _boundDeviceOfflineChatTimer = setTimeout(() => {
      _boundDeviceOfflineChatTimer = null
      _boundDeviceOfflineChatEmitted = true
      emitDeviceStatusMessage(offlineText)
    }, BOUND_DEVICE_OFFLINE_CHAT_GRACE_MS)
  } else if (payload.status === 'busy') {
    emitDeviceStatusMessage(i18n.t('space:device.emitBusy', n))
  } else if (payload.status === 'online') {
    _clearBoundDeviceOfflineChatGrace()
    toast({
      title: i18n.t('space:device.toastOnlineTitle', n),
      description: i18n.t('space:device.toastOnlineDesc'),
      variant: 'success',
    })
    // 仅当宽限已过、对话里已有 offline 横幅时，才补 online 配对消息。
    if (_boundDeviceOfflineChatEmitted) {
      emitDeviceStatusMessage(i18n.t('space:device.emitOnline', n))
      _boundDeviceOfflineChatEmitted = false
    }
  }
}

interface DeviceStatusPayload {
  device_id: string
  user_id?: string
  fingerprint: string
  name: string
  device_type: string
  role?: Device['role']
  status: 'online' | 'busy' | 'offline'
  capabilities: string[]
}

interface DeviceUnboundPayload {
  device_id: string
  agent_id: string
  organization_id?: string
}

interface DeviceState {
  /** 当前 Electron 设备（注册成功后可用） */
  currentDevice: Device | null
  /** 用户所有设备列表 */
  devices: Device[]
  /** 设备注册是否已完成 */
  registered: boolean
  isLoading: boolean
  error: string | null

  registerCurrentDevice: (organizationId: string) => Promise<Device | null>
  loadDevices: (organizationId?: string) => Promise<void>
  getCurrentFingerprint: () => string
  updateDeviceName: (deviceId: string, name: string) => Promise<boolean>
  deleteDevice: (deviceId: string) => Promise<boolean>
  clearDevices: () => void
  /** 全局 WS 监听（幂等，应用启动后调用一次，不会 teardown） */
  initGlobalWsListener: () => void
  /** @deprecated 使用 initGlobalWsListener 替代 */
  setupWsListener: () => void
  /** @deprecated 全局监听不需要 teardown */
  teardownWsListener: () => void
}

const USER_LEVEL_DEVICE_TYPES = new Set(['electron'])

export { USER_LEVEL_DEVICE_TYPES }

const _deviceInFlight = new Map<string, Promise<void>>()
let _heartbeatInterval: SleepAwareInterval | null = null

/**
 * /#363：设备注册失败后的指数退避自动重试。
 * 5s 起步、每次翻倍、60s 封顶；注册成功 / 登出（clearDevices）时取消。
 */
const REGISTER_RETRY_BASE_DELAY_MS = 5_000
const REGISTER_RETRY_MAX_DELAY_MS = 60_000
let _registerRetryTimer: ReturnType<typeof setTimeout> | null = null
let _registerRetryAttempt = 0
/** 最近一次注册尝试的 organization，恢复时机无 selectedOrganization 时兜底用。 */
let _lastRegisterOrganizationId: string | null = null
let _activeRegistrationOrganizationId: string | null = null
let _registrationGeneration = 0

/** 从错误对象提取「endpoint → 原因」描述（endpoint 由 deviceApi 失败时附带）。 */
function _describeDeviceError(error: unknown): string {
  const endpoint = (error as { endpoint?: string } | null)?.endpoint
  const msg = error instanceof Error ? error.message : String(error)
  return endpoint ? `${endpoint} → ${msg}` : msg
}

function _cancelRegisterRetry(): void {
  if (_registerRetryTimer) {
    clearTimeout(_registerRetryTimer)
    _registerRetryTimer = null
  }
  _registerRetryAttempt = 0
}

function _scheduleRegisterRetry(organizationId: string): void {
  if (_registerRetryTimer) return
  const delay = Math.min(
    REGISTER_RETRY_BASE_DELAY_MS * 2 ** _registerRetryAttempt,
    REGISTER_RETRY_MAX_DELAY_MS,
  )
  _registerRetryAttempt++
  logger.warn(`[Device] Registration retry #${_registerRetryAttempt} scheduled in ${delay}ms`)
  _registerRetryTimer = setTimeout(() => {
    _registerRetryTimer = null
    const state = useDeviceStore.getState()
    if (state.registered) return
    // 重试时优先用当前选中 organization（期间用户可能已切换）
    const currentOrganizationId = useOrganizationStore.getState().selectedOrganization?.id ?? organizationId
    void state.registerCurrentDevice(currentOrganizationId)
  }, delay)
}

/**
 * 恢复时机（网络 online / WS 重连 / 系统唤醒）触发的去重注册：
 * 未注册时立即重试（取消等待中的退避计时器），已注册则 no-op。
 * 并发安全由 AgentHost DeviceIdentityCoordinator 统一保证。
 */
export function ensureDeviceRegistered(): void {
  const state = useDeviceStore.getState()
  if (state.registered) return
  const organizationId =
    useOrganizationStore.getState().selectedOrganization?.id ?? _lastRegisterOrganizationId
  if (!organizationId) return
  if (_registerRetryTimer) {
    clearTimeout(_registerRetryTimer)
    _registerRetryTimer = null
  }
  void state.registerCurrentDevice(organizationId)
}
let _wsListener: ((envelope: any) => void) | null = null
let _globalWsInitialized = false
let _globalWsRetryCount = 0
const _GLOBAL_WS_MAX_RETRIES = 10
let _cachedAuthToken = ''
let _beforeUnloadRegistered = false
let _wsReconnectHandler: (() => void) | null = null

export function startHeartbeat() {
  stopHeartbeat()
  getAuthToken().then((t) => { _cachedAuthToken = t }).catch(() => {})

  const sendHeartbeat = async () => {
    const fingerprint = getOrCreateDeviceId()
    const runtimeSnapshot = await collectCurrentHostRuntimeSnapshot().catch(() => null)
    const systemInfo = runtimeSnapshot ? { host_runtime_snapshot: runtimeSnapshot } : undefined
    DeviceApiService.heartbeat(fingerprint, {
      capabilities: ELECTRON_CAPABILITIES,
      ...(systemInfo ? { system_info: systemInfo } : {}),
    }).catch((e) => {
      logger.warn('[Device] Heartbeat failed:', _describeDeviceError(e))
    })
    getAuthToken().then((t) => { _cachedAuthToken = t }).catch(() => {})
  }

  void sendHeartbeat()
  _heartbeatInterval = createSleepAwareInterval(
    () => { void sendHeartbeat() },
    HEARTBEAT_INTERVAL_MS,
  )
  _heartbeatInterval.start()

  if (!_beforeUnloadRegistered) {
    _beforeUnloadRegistered = true
    window.addEventListener('beforeunload', _handleBeforeUnload)
    window.__tabtin_report_offline = _handleBeforeUnload
  }
}

export function stopHeartbeat() {
  if (_heartbeatInterval) {
    _heartbeatInterval.stop()
    _heartbeatInterval = null
  }
}

function _handleBeforeUnload(): void {
  const fingerprint = getOrCreateDeviceId()
  DeviceApiService.reportOfflineSync(fingerprint, _cachedAuthToken)
}

export const useDeviceStore = create<DeviceState>((set, get) => ({
  currentDevice: null,
  devices: [],
  registered: false,
  isLoading: false,
  error: null,

  registerCurrentDevice: async (organizationId: string) => {
    const organizationChanged =
      _activeRegistrationOrganizationId != null
      && _activeRegistrationOrganizationId !== organizationId
    if (_activeRegistrationOrganizationId !== organizationId) {
      _activeRegistrationOrganizationId = organizationId
      _registrationGeneration += 1
    }
    const registrationGeneration = _registrationGeneration
    _lastRegisterOrganizationId = organizationId
    const identity = getSyncedDeviceIdentity()
    const fingerprint = identity?.fingerprint || getOrCreateDeviceId()
    set({
      ...(organizationChanged ? { currentDevice: null, registered: false } : {}),
      isLoading: true,
      error: null,
    })

    try {
      const register = window.tabtin?.ensureDeviceRegistered
      if (!register) throw new Error('AgentHost device registration bridge unavailable')
      const device = await register(organizationId) as Device
      if (registrationGeneration !== _registrationGeneration) return null

      const currentDevices = get().devices ?? []
      set({
        currentDevice: device,
        registered: true,
        isLoading: false,
        devices: currentDevices.some((d) => d.id === device.id)
          ? currentDevices.map((d) => (d.id === device.id ? device : d))
          : [device, ...currentDevices],
      })

      logger.log('[Device] Registration succeeded:', device.name, '(', fingerprint.slice(0, 16), '...)')
      _cancelRegisterRetry()
      startHeartbeat()
      return device
    } catch (error) {
      if (registrationGeneration !== _registrationGeneration) return null
      const msg = error instanceof Error ? error.message : i18n.t('space:device.registerFailed')
      if (isOrganizationPermissionMessage(msg)) {
        logger.warn('[Device] Registration denied for organization, triggering recovery:', _describeDeviceError(error))
        set({ isLoading: false, error: msg })
        _cancelRegisterRetry()
        void recoverFromInvalidOrganizationAccess(organizationId)
        return null
      }
      logger.warn('[Device] Registration failed, will retry:', _describeDeviceError(error))
      set({ isLoading: false, error: msg })
      _scheduleRegisterRetry(organizationId)
      return null
    }
  },

  loadDevices: async (organizationId?: string) => {
    await dedupAsync(_deviceInFlight, `devices:${organizationId ?? '__all__'}`, async () => {
      set({ isLoading: true })
      try {
        const result: DeviceListResponse = await DeviceApiService.listDevices(organizationId)
        set({ devices: result.devices ?? [], isLoading: false })
      } catch (error) {
        logger.warn('[Device] Failed to load device list:', error)
        set({ isLoading: false })
      }
    })
  },

  getCurrentFingerprint: () => getOrCreateDeviceId(),

  updateDeviceName: async (deviceId: string, name: string) => {
    try {
      const updated = await DeviceApiService.updateDevice(deviceId, { name })
      set((state) => ({
        devices: state.devices.map((d) => (d.id === deviceId ? updated : d)),
        currentDevice:
          state.currentDevice?.id === deviceId ? updated : state.currentDevice,
      }))
      return true
    } catch {
      return false
    }
  },

  deleteDevice: async (deviceId: string) => {
    try {
      await DeviceApiService.deleteDevice(deviceId)
      set((state) => ({
        devices: state.devices.filter((d) => d.id !== deviceId),
        currentDevice:
          state.currentDevice?.id === deviceId ? null : state.currentDevice,
      }))
      return true
    } catch {
      return false
    }
  },

  clearDevices: () => {
    _globalWsInitialized = false
    _globalWsRetryCount = 0
    _cancelRegisterRetry()
    _lastRegisterOrganizationId = null
    _activeRegistrationOrganizationId = null
    _registrationGeneration += 1
    _clearBoundDeviceOfflineChatGrace()
    _boundDeviceOfflineChatEmitted = false
    stopHeartbeat()
    _deviceInFlight.clear()
    if (_cachedAuthToken) {
      const fingerprint = getOrCreateDeviceId()
      DeviceApiService.reportOfflineSync(fingerprint, _cachedAuthToken)
    }
    _cachedAuthToken = ''
    set({ currentDevice: null, devices: [], registered: false })
  },

  initGlobalWsListener: () => {
    if (_globalWsInitialized) return
    _globalWsInitialized = true

    const retry = (err?: unknown) => {
      _globalWsInitialized = false
      _globalWsRetryCount++
      if (_globalWsRetryCount <= _GLOBAL_WS_MAX_RETRIES) {
        const delay = Math.min(3000 * _globalWsRetryCount, 15000)
        setTimeout(() => { get().initGlobalWsListener() }, delay)
      } else {
        logger.warn('[Device] WS listener init failed, max retries reached:', err instanceof Error ? err.message : String(err ?? ''))
      }
    }

    try {
      try {
        const gateway = getChatClient().getGateway()

        const listener = (envelope: any) => {
          if (envelope?.type === DomainEvents.DEVICE_UNBOUND) {
            const payload = envelope.payload as DeviceUnboundPayload | undefined
            const currentDeviceId = useDeviceStore.getState().currentDevice?.id
            if (payload?.device_id && payload?.agent_id && payload.device_id === currentDeviceId) {
              const spaceState = useSpaceStore.getState()
              void spaceState.loadAgent(payload.agent_id, { force: true })
              const affectedSpace = spaceState.spaces.find((space) => space.agent_id === payload.agent_id)
              if (affectedSpace) {
                void spaceState.refreshSpace(affectedSpace.id)
              }
            }
            return
          }

          if (envelope?.type !== DomainEvents.DEVICE_STATUS) return

          const payload = envelope.payload as DeviceStatusPayload | undefined
          if (!payload?.device_id) return

          set((state) => {
            const currentDevices = state.devices ?? []
            const existingDevice = currentDevices.find((d) => d.id === payload.device_id)
            const deviceExists = !!existingDevice
            const currentUserId = String(useAuthStore.getState().user?.id ?? '')
            const isOwnedByCurrentUser = !!payload.user_id && payload.user_id === currentUserId
            const selectedOrganizationId = String(useOrganizationStore.getState().selectedOrganization?.id ?? '')
            const eventOrganizationId = String(envelope.organization_id ?? '')
            const isCurrentOrganizationEvent =
              !!eventOrganizationId && !!selectedOrganizationId && eventOrganizationId === selectedOrganizationId

            if (deviceExists) {
              const isUserLevelDevice = USER_LEVEL_DEVICE_TYPES.has(existingDevice?.device_type ?? '')
              if (!isUserLevelDevice && existingDevice?.organization_id && eventOrganizationId && existingDevice.organization_id !== eventOrganizationId) {
                return {}
              }
              const statusChanged = existingDevice?.status !== payload.status
              const nameChanged = payload.name != null && existingDevice?.name !== payload.name
              const roleChanged = payload.role != null && existingDevice?.role !== payload.role
              if (!statusChanged && !nameChanged && !roleChanged) {
                return {}
              }
              if (statusChanged) {
                void _notifyBoundDeviceStatusChange(payload)
              }
              return {
                devices: currentDevices.map((d) =>
                  d.id === payload.device_id
                    ? {
                        ...d,
                        status: payload.status,
                        name: payload.name,
                        capabilities: payload.capabilities,
                        role: payload.role ?? d.role,
                      }
                    : d
                ),
                currentDevice:
                  state.currentDevice?.id === payload.device_id
                    ? {
                        ...state.currentDevice,
                        status: payload.status,
                        name: payload.name,
                        capabilities: payload.capabilities,
                        role: payload.role ?? state.currentDevice.role,
                      }
                    : state.currentDevice,
              }
            }

            if (payload.status === 'online' || payload.status === 'busy') {
              if (!isOwnedByCurrentUser) {
                if (!payload.user_id && envelope.organization_id) {
                  void get().loadDevices(envelope.organization_id)
                }
                return {}
              }
              const isNewUserLevelDevice = USER_LEVEL_DEVICE_TYPES.has(payload.device_type ?? '')
              if (!isCurrentOrganizationEvent && !isNewUserLevelDevice) {
                return {}
              }

              const newDevice: Device = {
                id: payload.device_id,
                organization_id: envelope.organization_id ?? '',
                user_id: payload.user_id ?? '',
                name: payload.name,
                device_type: payload.device_type as Device['device_type'],
                role: payload.role ?? (payload.device_type === 'mobile' || payload.device_type === 'iot' ? 'data' : 'control'),
                fingerprint: payload.fingerprint,
                os_info: {},
                capabilities: payload.capabilities,
                status: payload.status,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }
              return { devices: [newDevice, ...currentDevices] }
            }

            return {}
          })
        }

        gateway.addListener(listener)

        if (_wsReconnectHandler) {
          gateway.offReconnectedEvent(_wsReconnectHandler)
        }
        _wsReconnectHandler = () => {
          // /#363：WS 重连说明后端已可达——若设备尚未注册（启动竞争 /
          // 瞬时失败遗留），先补注册（成功后内部会启动心跳），而不是只发心跳。
          if (!useDeviceStore.getState().registered) {
            ensureDeviceRegistered()
            return
          }
          const fingerprint = getOrCreateDeviceId()
          collectCurrentHostRuntimeSnapshot()
            .then((snapshot) => DeviceApiService.heartbeat(fingerprint, {
              capabilities: ELECTRON_CAPABILITIES,
              system_info: { host_runtime_snapshot: snapshot },
            }))
            .catch(() => DeviceApiService.heartbeat(fingerprint, {
              capabilities: ELECTRON_CAPABILITIES,
            }))
            .catch((e) => {
              logger.warn('[Device] Heartbeat after WS reconnect failed:', _describeDeviceError(e))
            })
        }
        gateway.onReconnectedEvent(_wsReconnectHandler)

        _globalWsRetryCount = 0
        logger.log('[Device] Global WS listener started')
      } catch (innerErr) {
        retry(innerErr)
      }
    } catch (outerErr) {
      retry(outerErr)
    }
  },

  setupWsListener: () => {
    get().initGlobalWsListener()
  },

  teardownWsListener: () => {
    // no-op: 全局监听不需要 teardown
  },
}))

registerResetAction('device', 'reset', () => useDeviceStore.getState().clearDevices())

onOrganizationSelected((organizationId) => {
  const { registered, loadDevices, registerCurrentDevice } = useDeviceStore.getState()
  if (registered) {
    loadDevices(organizationId).catch(e => {
      logger.warn('[Device] organization selected → loadDevices failed:',
        e instanceof Error ? e.message : String(e))
    })
  } else {
    registerCurrentDevice(organizationId).catch(e => {
      logger.warn('[Device] organization selected → device registration failed:',
        e instanceof Error ? e.message : String(e))
    })
  }
})
