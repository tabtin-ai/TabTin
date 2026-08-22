import { okResponse } from '@tabtin/agent-wire'

import { guardedHandle } from './utils/guarded-handle'
import { currentDeviceIdentity } from './agent/device-identity/currentDeviceIdentity.js'

export const DEVICE_IDENTITY_IPC_CHANNEL = 'device:getIdentity'
export const DEVICE_REGISTER_IPC_CHANNEL = 'device:ensureRegistered'

/**
 * 设备完整身份必须走标准 IPC envelope。
 *
 * preload 的 invokeIpc 会拒绝未登记的 raw object；此前这里直接返回
 * DeviceIdentity，导致 renderer 永远拿不到 previousFingerprint，只能回退到
 * device:getFingerprint，生产设备 reclaim 因而失效。
 */
export function registerDeviceIdentityIpcHandler(): void {
  guardedHandle(DEVICE_IDENTITY_IPC_CHANNEL, () => okResponse(currentDeviceIdentity.getSnapshot()))
  guardedHandle(
    DEVICE_REGISTER_IPC_CHANNEL,
    (_event, input: { organizationId?: string }) =>
      currentDeviceIdentity.ensureRegistered(input?.organizationId ?? '').then(okResponse),
  )
}
