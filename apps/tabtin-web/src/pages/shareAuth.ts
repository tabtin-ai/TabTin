/**
 * 分享查看页的登录态工具。
 *
 * 公开分享页（/shared/...）是公共路由，访问者可能未登录。但 organization
 * 限定分享需要后端识别访问者身份，因此登录时必须把 access token 带上 ——
 * 否则后端无法判断访问者是否为该团队成员，会一律按匿名拒绝（403）。
 */
import { STORAGE_KEYS } from '@/platform'

/** 当前登录态的访问令牌；未登录返回 null。 */
export function getAccessToken(): string | null {
  return localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN)
}

/** 分享页请求头：登录时带上 Bearer，便于后端识别 organization 成员身份。 */
export function shareAuthHeaders(): Record<string, string> {
  const token = getAccessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}
