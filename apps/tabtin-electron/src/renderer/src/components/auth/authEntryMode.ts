import { DEVICE_LOCAL_KEYS } from '@/stores/persist-key-registry'

export type InitialAuthEntryMode = 'login' | 'register'

/**
 * 新安装首次进入认证页时优先展示注册；此后（包括退出登录、修改/重置密码后）
 * 都回到登录页。入口记忆是设备级状态，不包含账号身份或凭证。
 */
export function resolveInitialAuthEntryMode(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): InitialAuthEntryMode {
  if (!storage) return 'login'

  const hasSeenAuthEntry = storage.getItem(DEVICE_LOCAL_KEYS.authEntrySeen) === '1'
  if (hasSeenAuthEntry) return 'login'

  storage.setItem(DEVICE_LOCAL_KEYS.authEntrySeen, '1')
  return 'register'
}
