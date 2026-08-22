import { useQuery } from '@tanstack/react-query'
import { listAccountDevices } from '@/services/daemonControlApi'
import { useAuthStore } from '@/stores/useAuthStore'

export const accountDeviceKeys = {
  all: ['account-devices'] as const,
  list: (userId: string) => [...accountDeviceKeys.all, 'list', userId] as const,
}

/**
 * 账号设备共享查询。在线状态是服务端实时查询快照，因此打开页面和窗口重新聚焦时重拉；
 * 不轮询，也不新增长连接。
 */
export function useAccountDevicesQuery(options: { enabled?: boolean } = {}) {
  const userId = useAuthStore((state) => String(state.user?.id ?? ''))
  return useQuery({
    queryKey: accountDeviceKeys.list(userId),
    queryFn: listAccountDevices,
    enabled: Boolean(userId) && (options.enabled ?? true),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })
}
