import { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'

type LaunchParams = {
  organizationId?: string
  spaceId?: string
  slideId?: string
}

const normalizeId = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const encodePathSegment = (value: string): string => encodeURIComponent(value)

export function useSlideLaunchContext() {
  const params = useParams<LaunchParams>()
  const [searchParams] = useSearchParams()

  return useMemo(() => {
    const organizationId =
      normalizeId(params.organizationId) ??
      normalizeId(searchParams.get('organizationId'))

    const spaceId =
      normalizeId(params.spaceId) ??
      normalizeId(searchParams.get('spaceId'))

    const slideId =
      normalizeId(params.slideId) ??
      normalizeId(searchParams.get('slideId'))

    const buildHomePath = (): string => {
      if (organizationId && spaceId) {
        return `/organizations/${encodePathSegment(organizationId)}/spaces/${encodePathSegment(spaceId)}`
      }
      if (spaceId) {
        return `/spaces/${encodePathSegment(spaceId)}`
      }
      return '/'
    }

    return {
      organizationId,
      spaceId,
      slideId,
      hasSpaceContext: Boolean(spaceId),
      hasOrganizationSpaceContext: Boolean(organizationId && spaceId),
      buildHomePath,
    }
  }, [params.slideId, params.spaceId, params.organizationId, searchParams])
}
