import { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { normalizeTableIdCandidate } from './tableId'

type LaunchParams = {
  organizationId?: string
  spaceId?: string
  tableId?: string
}

const normalizeId = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

const encodePathSegment = (value: string): string => encodeURIComponent(value)

export function useTableLaunchContext() {
  const params = useParams<LaunchParams>()
  const [searchParams] = useSearchParams()

  return useMemo(() => {
    const organizationId =
      normalizeId(params.organizationId) ??
      normalizeId(searchParams.get('organizationId'))

    const spaceId =
      normalizeId(params.spaceId) ??
      normalizeId(searchParams.get('spaceId')) ??
      normalizeId(searchParams.get('spaceId'))

    const tableId =
      normalizeTableIdCandidate(params.tableId) ??
      normalizeTableIdCandidate(searchParams.get('tableId'))

    const buildHomePath = (): string => {
      if (organizationId && spaceId) {
        return `/organizations/${encodePathSegment(organizationId)}/spaces/${encodePathSegment(spaceId)}`
      }
      if (spaceId) {
        return `/spaces/${encodePathSegment(spaceId)}`
      }
      return '/'
    }

    const buildTablePath = (nextTableId: string): string => {
      const normalizedTableId = nextTableId.trim()
      if (organizationId && spaceId) {
        return `/organizations/${encodePathSegment(organizationId)}/spaces/${encodePathSegment(spaceId)}/tables/${encodePathSegment(normalizedTableId)}`
      }
      if (spaceId) {
        return `/spaces/${encodePathSegment(spaceId)}/tables/${encodePathSegment(normalizedTableId)}`
      }
      return `/tables/${encodePathSegment(normalizedTableId)}`
    }

    return {
      organizationId,
      spaceId,
      tableId,
      hasSpaceContext: Boolean(spaceId),
      hasOrganizationSpaceContext: Boolean(organizationId && spaceId),
      buildHomePath,
      buildTablePath,
    }
  }, [params.spaceId, params.tableId, params.organizationId, searchParams])
}
