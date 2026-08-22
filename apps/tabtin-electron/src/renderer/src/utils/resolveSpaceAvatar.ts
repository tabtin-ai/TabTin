import { TABTIN_APP_ICON_URL } from '@/constants/appIcon'

export function resolveSpaceAvatarUrl(avatar?: string | null): string {
  const trimmed = avatar?.trim()
  return trimmed || TABTIN_APP_ICON_URL
}
