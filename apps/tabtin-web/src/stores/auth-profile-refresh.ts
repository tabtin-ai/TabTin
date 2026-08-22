import type { UserInfo } from '@/types/auth'

interface RefreshStoredUserProfileInput {
  storedUser: UserInfo
  loadProfile: () => Promise<UserInfo>
  persistUser: (user: UserInfo) => Promise<void>
}

/**
 * Restored web sessions can contain an old avatar object key or an expired
 * signed URL. Refresh the profile opportunistically without making a
 * temporary profile/network failure log the user out.
 */
export async function refreshStoredUserProfile({
  storedUser,
  loadProfile,
  persistUser,
}: RefreshStoredUserProfileInput): Promise<UserInfo> {
  try {
    const latestUser = await loadProfile()
    await persistUser(latestUser)
    return latestUser
  } catch {
    return storedUser
  }
}
