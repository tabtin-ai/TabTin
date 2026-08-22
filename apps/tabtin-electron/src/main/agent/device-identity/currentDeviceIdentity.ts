import { TokenManager } from '../../auth.js'
import { DeviceIdentityCoordinator } from './DeviceIdentityCoordinator.js'
import { electronDeviceRegistrationAdapter } from './electronDeviceRegistrationAdapter.js'

export const currentDeviceIdentity = new DeviceIdentityCoordinator(
  electronDeviceRegistrationAdapter,
)

type AuthUser = { id?: unknown; user_id?: unknown; userId?: unknown } | null

function resolveAuthUserId(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null
  const authUser = user as AuthUser
  const rawId = authUser?.id ?? authUser?.user_id ?? authUser?.userId
  const userId = typeof rawId === 'string' ? rawId.trim() : ''
  return userId || null
}

let registrationOwnerId = resolveAuthUserId(TokenManager.getCachedUserInfo())

TokenManager.onAuthChanged(() => {
  const nextUserId = resolveAuthUserId(TokenManager.getCachedUserInfo())
  if (nextUserId === registrationOwnerId) return
  registrationOwnerId = nextUserId
  currentDeviceIdentity.resetRegistration()
})
