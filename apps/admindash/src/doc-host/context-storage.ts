import { DOC_HOST_CONTEXT_STORAGE_KEY } from '@/doc-host/constants'

export interface SavedDocContext {
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

export const readSavedDocContext = (): SavedDocContext => {
  try {
    const raw = localStorage.getItem(DOC_HOST_CONTEXT_STORAGE_KEY)
    if (!raw) {
      return { organizationId: '', spaceId: '' }
    }

    const parsed = JSON.parse(raw) as Partial<SavedDocContext> & { workspaceId?: string }
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

export const saveDocContext = (context: SavedDocContext): void => {
  localStorage.setItem(DOC_HOST_CONTEXT_STORAGE_KEY, JSON.stringify(context))
}

export const hasAccessToken = (): boolean => Boolean(localStorage.getItem('access_token'))
