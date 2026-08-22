import type { HostTurnStore } from '@tabtin/agent-host/policy'
import type { DeviceIdentityStore } from '@tabtin/agent-host/state'
import type { AgentEngineExecutionTarget } from '../../../shared/types/agent-engine.js'
import { createLogger } from '../../logger.js'

const log = createLogger('ExecutionTarget')

/** AgentHost 接受本机执行前，只读取初始化阶段同步的权威绑定快照。 */
export function validateLocalExecutionTarget(
  input: {
    sessionId: string
    workspaceId: string
    target: AgentEngineExecutionTarget
    turnStore: HostTurnStore
    deviceIdentityStore: DeviceIdentityStore
  },
): void {
  const sessionId = input.sessionId.slice(0, 8)
  const targetDeviceId = input.target.device_identity_key.slice(0, 8)
  const binding = input.turnStore.getWorkspaceExecutionBinding(input.workspaceId)
  const registration = input.deviceIdentityStore.getRegistration()
  const bindingDeviceId = binding?.deviceId.slice(0, 8) ?? 'missing'
  const registrationDeviceId = registration?.deviceId.slice(0, 8) ?? 'missing'
  log.info(
    `[validate] start session=${sessionId}… target=${targetDeviceId}… binding=${bindingDeviceId}… registration=${registrationDeviceId}…`,
  )
  try {
    if (!input.turnStore.areExecutionBindingsReady()) {
      throw new Error('workspace execution binding state is not ready')
    }
    if (!binding || binding.deviceId !== input.target.device_identity_key) {
      throw new Error('workspace execution target does not match this device')
    }
    if (!registration || registration.deviceId !== input.target.device_identity_key) {
      throw new Error('current AgentHost device does not match workspace execution target')
    }
    log.info(`[validate] accepted session=${sessionId}…`)
  } catch (error) {
    log.error(
      `[validate] rejected session=${sessionId}… error=${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}
