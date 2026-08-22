import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { ServiceDisabledError } from '@/services/apiBase'
import { canManageOrganization } from '@/hooks/useCanManageOrganization'
import { useOrganizationStore } from '@tabtin/app-shell'

function isServiceDisabled(error: unknown): boolean {
  if (error instanceof ServiceDisabledError) return true
  if (
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === 'SERVICE_DISABLED'
  )
    return true
  return false
}

function getServiceKey(error: unknown): string {
  if (error instanceof ServiceDisabledError) return error.serviceKey
  if (error instanceof Error && 'serviceKey' in error) {
    return (error as Error & { serviceKey: string }).serviceKey || ''
  }
  return ''
}

function resolveServiceName(serviceKey: string): string {
  if (!serviceKey) return i18n.t('settings:organizationServices.serviceNames.default')
  const key = `settings:organizationServices.serviceNames.${serviceKey}`
  const name = i18n.t(key)
  return name === key ? i18n.t('settings:organizationServices.serviceNames.default') : name
}

function isWorkspaceAdmin(): boolean {
  return canManageOrganization(useOrganizationStore.getState().currentUserRole)
}

/**
 * 检查并处理 ServiceDisabledError，显示带操作按钮的 toast。
 * 当前未上线的 AI 能力开关不在设置页暴露，因此只解释原因，不再跳到设置页。
 * - toast 标题包含具体服务名（如「语音合成」已被禁用）
 *
 * 返回 true 表示已处理，调用方可跳过通用 toast.error。
 */
export function handleServiceDisabledError(error: unknown): boolean {
  if (!isServiceDisabled(error)) return false

  const serviceKey = getServiceKey(error)
  const serviceName = resolveServiceName(serviceKey)
  const admin = isWorkspaceAdmin()

  const title = serviceKey
    ? i18n.t('settings:organizationServices.serviceDisabled', { serviceName })
    : i18n.t('settings:organizationServices.serviceDisabledFallback')

  const description = admin
    ? i18n.t('settings:organizationServices.serviceDisabledDesc')
    : i18n.t('settings:organizationServices.serviceDisabledDescMember')

  toast({
    title,
    description,
    variant: 'destructive',
    duration: 8000,
  })
  return true
}
