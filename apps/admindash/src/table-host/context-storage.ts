import { TABLE_HOST_CONTEXT_STORAGE_KEY } from '@/table-host/constants'

export interface SavedContext {
  organizationId: string
  spaceId: string
}

export const normalizeRouteParam = (value: string | undefined): string => {
  if (!value) {
    return ''
  }

  try {
    return decodeURIComponent(value).trim()
  } catch {
    return value.trim()
  }
}

export const readSavedContext = (): SavedContext => {
  try {
    const raw = localStorage.getItem(TABLE_HOST_CONTEXT_STORAGE_KEY)
    if (!raw) {
      return { organizationId: '', spaceId: '' }
    }
    const parsed = JSON.parse(raw) as Partial<SavedContext> & { workspaceId?: string }
    // 老版本 localStorage 可能写的是 workspaceId，向后兼容读取
    const organizationId =
      typeof parsed.organizationId === 'string'
        ? parsed.organizationId
        : typeof parsed.workspaceId === 'string'
          ? parsed.workspaceId
          : ''
    return {
      organizationId,
      spaceId: typeof parsed.spaceId === 'string' ? parsed.spaceId : '',
    }
  } catch {
    return { organizationId: '', spaceId: '' }
  }
}

export const saveContext = (context: SavedContext): void => {
  localStorage.setItem(TABLE_HOST_CONTEXT_STORAGE_KEY, JSON.stringify(context))
}

export const hasAccessToken = (): boolean => Boolean(localStorage.getItem('access_token'))
