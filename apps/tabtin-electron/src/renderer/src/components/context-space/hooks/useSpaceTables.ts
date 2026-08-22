import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTableSpaceId, TableApiService, type Table } from '@tabtin/table-core'
import { useCreateTable, useCreateTableInSpace, useTableStore } from '@stores/useTableStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { onResourceEvent } from '@/stores/useUnifiedResources'
import { useSpaceActivity } from '@components/layout/SpaceActivityContext'

const EMPTY_TABLES: Table[] = []

export function useSpaceTables(
  spaceId: string,
  organizationIdOverride?: string,
  scope: 'space' | 'organization' = 'organization',
) {
  const organizationError = useOrganizationStore(state => state.error)
  const tables = useTableStore(state => state.tables)
  const isLoading = useTableStore(state => state.isLoading)
  const error = useTableStore(state => state.error)
  const loadTablesBySpace = useTableStore(state => state.loadTablesBySpace)
  const createTableInSpace = useCreateTableInSpace()
  const createTable = useCreateTable()
  const [organizationTables, setOrganizationTables] = useState<Table[]>(EMPTY_TABLES)
  const [isOrganizationLoading, setIsOrganizationLoading] = useState(false)
  const [organizationLoadError, setOrganizationLoadError] = useState<string | null>(null)

  const resolvedOrganizationId = useResolvedOrganizationId(organizationIdOverride)
  const { isForeground } = useSpaceActivity()

  const spaceTables = useMemo(() => {
    return tables.filter(table => getTableSpaceId(table) === spaceId)
  }, [tables, spaceId])
  const visibleTables = useMemo(() => {
    if (scope === 'organization') {
      return organizationTables
    }
    return spaceTables
  }, [scope, spaceTables, organizationTables])

  const loadOrganizationTables = useCallback(async () => {
    if (!resolvedOrganizationId) return
    setIsOrganizationLoading(true)
    setOrganizationLoadError(null)
    try {
      const response = await TableApiService.getAllTablesInOrganization(resolvedOrganizationId, {
        include_system: true,
        current_space_id: spaceId || undefined,
      })
      setOrganizationTables(response.tables)
      setOrganizationLoadError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setOrganizationLoadError(message)
      setOrganizationTables(EMPTY_TABLES)
    } finally {
      setIsOrganizationLoading(false)
    }
  }, [resolvedOrganizationId, spaceId])

  useEffect(() => {
    if (!isForeground || !resolvedOrganizationId || !spaceId || organizationError) return
    if (scope === 'organization') {
      void loadOrganizationTables()
      return
    }
    loadTablesBySpace(resolvedOrganizationId, spaceId)
  }, [isForeground, resolvedOrganizationId, spaceId, organizationError, loadTablesBySpace, loadOrganizationTables, scope])

  useEffect(() => {
    if (scope === 'organization') return
    if (organizationTables.length > 0 || isOrganizationLoading || organizationLoadError) {
      setOrganizationTables(EMPTY_TABLES)
      setIsOrganizationLoading(false)
      setOrganizationLoadError(null)
    }
  }, [isOrganizationLoading, scope, organizationLoadError, organizationTables.length])

  // WS 实时刷新：tabdata 资源变更时自动重新加载表格列表
  const reloadRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const reload = useCallback(() => {
    if (!resolvedOrganizationId || !spaceId) return
    clearTimeout(reloadRef.current)
    reloadRef.current = setTimeout(() => {
      if (scope === 'organization') {
        void loadOrganizationTables()
        return
      }
      loadTablesBySpace(resolvedOrganizationId, spaceId)
    }, 600)
  }, [resolvedOrganizationId, spaceId, loadTablesBySpace, loadOrganizationTables, scope])

  useEffect(() => {
    if (!isForeground || !spaceId) return
    const unsub = scope === 'organization'
      ? onResourceEvent('tabdata', reload)
      : onResourceEvent('tabdata', reload, { spaceId })
    return () => {
      unsub()
      clearTimeout(reloadRef.current)
    }
  }, [isForeground, reload, spaceId, scope])

  return {
    resolvedOrganizationId,
    spaceTables,
    visibleTables,
    isLoading: scope === 'organization' ? isOrganizationLoading : isLoading,
    error: scope === 'organization' ? organizationLoadError : error,
    createTable,
    createTableInSpace,
  }
}

