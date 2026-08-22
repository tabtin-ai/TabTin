import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TableApiService, type Table } from '@tabtin/table-core'
import { useAuthStore } from '@/stores/auth-store'
import { getDisplayName } from '@/types/auth'
import { useTranslation } from 'react-i18next'
import { configureWebTableRuntime } from '@/features/table/bootstrap'
import { isValidTableId, normalizeTableIdCandidate } from '@/features/table/tableId'
import { useTableLaunchContext } from '@/features/table/useTableLaunchContext'
import {
  listWorkspaceSpaces,
  listOrganizations,
  type SpaceSummary,
  type OrganizationSummary,
} from '@/features/table/services/contextApi'

const LAST_TABLE_ID_KEY = 'tabtin_web_last_table_id'
const LAST_ORGANIZATION_ID_KEY = 'tabtin_web_last_organization_id'
const LAST_SPACE_ID_KEY = 'tabtin_web_last_space_id'

const encodePathSegment = (value: string): string => encodeURIComponent(value)

export function HomePage() {
  const user = useAuthStore((s) => s.user)
  const { t } = useTranslation('common')
  const navigate = useNavigate()
  const displayName = getDisplayName(user, t('userFallback'))
  const {
    organizationId,
    spaceId,
    tableId: launchTableId,
    buildTablePath,
  } = useTableLaunchContext()
  const [tableId, setTableId] = useState(() => localStorage.getItem(LAST_TABLE_ID_KEY) ?? '')
  const [organizations, setOrganizations] = useState<OrganizationSummary[]>([])
  const [spaces, setSpaces] = useState<SpaceSummary[]>([])
  const [detectedOrganizationId, setDetectedOrganizationId] = useState<string | null>(null)
  const [detectedSpaceId, setDetectedSpaceId] = useState<string | null>(null)
  const [resolvedSpaceOrganization, setResolvedSpaceOrganization] = useState<{
    spaceId: string
    organizationId: string
  } | null>(null)
  const [isLoadingContext, setIsLoadingContext] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [spaceTables, setSpaceTables] = useState<Table[]>([])
  const [isLoadingTables, setIsLoadingTables] = useState(false)
  const [tablesError, setTablesError] = useState<string | null>(null)
  const [manualInputError, setManualInputError] = useState<string | null>(null)
  const hasExplicitOrganization = Boolean(organizationId)
  const hasExplicitSpace = Boolean(spaceId)
  const activeOrganizationId = organizationId
    ?? (
      hasExplicitSpace
        ? (resolvedSpaceOrganization?.spaceId === spaceId ? resolvedSpaceOrganization.organizationId : null)
        : detectedOrganizationId
    )
  const activeSpaceId = spaceId ?? detectedSpaceId
  const hasActiveOrganizationSpaceContext = Boolean(activeOrganizationId && activeSpaceId)

  const buildResolvedHomePath = (nextOrganizationId: string, nextSpaceId: string): string =>
    `/organizations/${encodePathSegment(nextOrganizationId)}/spaces/${encodePathSegment(nextSpaceId)}`

  const buildResolvedTablePath = (nextTableId: string): string => {
    const normalizedTableId = nextTableId.trim()
    if (organizationId && spaceId) {
      return `/organizations/${encodePathSegment(organizationId)}/spaces/${encodePathSegment(spaceId)}/tables/${encodePathSegment(normalizedTableId)}`
    }
    if (spaceId) {
      return `/spaces/${encodePathSegment(spaceId)}/tables/${encodePathSegment(normalizedTableId)}`
    }
    if (activeOrganizationId && activeSpaceId) {
      return `/organizations/${encodePathSegment(activeOrganizationId)}/spaces/${encodePathSegment(activeSpaceId)}/tables/${encodePathSegment(normalizedTableId)}`
    }
    return buildTablePath(nextTableId)
  }

  useEffect(() => {
    configureWebTableRuntime({ organizationId: activeOrganizationId, spaceId: activeSpaceId })
  }, [activeSpaceId, activeOrganizationId])

  useEffect(() => {
    let cancelled = false
    setIsLoadingContext(true)
    setContextError(null)

    void (async () => {
      try {
        const response = await listOrganizations()
        if (cancelled) {
          return
        }
        const nextOrganizations = response.organizations ?? []
        setOrganizations(nextOrganizations)

        if (hasExplicitOrganization || hasExplicitSpace) {
          setDetectedOrganizationId(null)
          return
        }

        const savedOrganizationId = localStorage.getItem(LAST_ORGANIZATION_ID_KEY)
        const resolvedOrganization =
          nextOrganizations.find((item) => item.id === savedOrganizationId) ??
          nextOrganizations.find((item) => item.is_default) ??
          nextOrganizations[0] ??
          null

        setDetectedOrganizationId(resolvedOrganization?.id ?? null)
      } catch (err) {
        if (cancelled) {
          return
        }
        setOrganizations([])
        setContextError(
          err instanceof Error
            ? err.message
            : t('home.loadWorkspaceFailed', { defaultValue: '加载工作空间失败' })
        )
      } finally {
        if (!cancelled) {
          setIsLoadingContext(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [hasExplicitSpace, hasExplicitOrganization, t])

  useEffect(() => {
    if (!hasExplicitSpace || hasExplicitOrganization || organizations.length === 0) {
      setResolvedSpaceOrganization(null)
      return
    }
    const targetSpaceId = spaceId
    if (!targetSpaceId) {
      setResolvedSpaceOrganization(null)
      return
    }

    let cancelled = false
    setIsLoadingContext(true)
    setContextError(null)
    setResolvedSpaceOrganization(null)

    void (async () => {
      try {
        for (const organization of organizations) {
          const response = await listWorkspaceSpaces(organization.id)
          if (cancelled) {
            return
          }
          if (response.spaces.some((item) => item.id === targetSpaceId)) {
            setResolvedSpaceOrganization({ spaceId: targetSpaceId, organizationId: organization.id })
            return
          }
        }

        setContextError(
          t('home.spaceResolveFailed', {
            defaultValue: '无法根据当前 spaceId 解析所属 workspace。',
          })
        )
      } catch (err) {
        if (cancelled) {
          return
        }
        setContextError(
          err instanceof Error
            ? err.message
            : t('home.spaceResolveFailed', {
              defaultValue: '无法根据当前 spaceId 解析所属 workspace。',
            })
        )
      } finally {
        if (!cancelled) {
          setIsLoadingContext(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [hasExplicitSpace, hasExplicitOrganization, spaceId, t, organizations])

  useEffect(() => {
    if (!activeOrganizationId) {
      setSpaces([])
      setDetectedSpaceId(null)
      return
    }

    let cancelled = false
    setIsLoadingContext(true)
    setContextError(null)
    setSpaces([])
    if (!spaceId) {
      setDetectedSpaceId(null)
    }

    void (async () => {
      try {
        const response = await listWorkspaceSpaces(activeOrganizationId)
        if (cancelled) {
          return
        }
        const nextSpaces = response.spaces ?? []
        setSpaces(nextSpaces)

        if (spaceId) {
          setDetectedSpaceId(null)
          return
        }

        const savedSpaceId = localStorage.getItem(LAST_SPACE_ID_KEY)
        const resolvedSpace =
          nextSpaces.find((item) => item.id === savedSpaceId) ??
          nextSpaces[0] ??
          null

        setDetectedSpaceId(resolvedSpace?.id ?? null)
      } catch (err) {
        if (cancelled) {
          return
        }
        setSpaces([])
        if (!spaceId) {
          setDetectedSpaceId(null)
        }
        setContextError(
          err instanceof Error
            ? err.message
            : t('home.loadSpaceFailed', { defaultValue: '加载 Space 失败' })
        )
      } finally {
        if (!cancelled) {
          setIsLoadingContext(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeOrganizationId, spaceId, t])

  useEffect(() => {
    if (!launchTableId) {
      return
    }
    localStorage.setItem(LAST_TABLE_ID_KEY, launchTableId)
    navigate(buildResolvedTablePath(launchTableId), { replace: true })
  }, [buildResolvedTablePath, launchTableId, navigate])

  useEffect(() => {
    if (!activeOrganizationId || !activeSpaceId) {
      return
    }

    localStorage.setItem(LAST_ORGANIZATION_ID_KEY, activeOrganizationId)
    localStorage.setItem(LAST_SPACE_ID_KEY, activeSpaceId)

    if ((organizationId && spaceId) || (spaceId && !organizationId)) {
      return
    }

    navigate(buildResolvedHomePath(activeOrganizationId, activeSpaceId), { replace: true })
  }, [activeSpaceId, activeOrganizationId, navigate, spaceId, organizationId])

  useEffect(() => {
    if (!hasActiveOrganizationSpaceContext || !activeOrganizationId || !activeSpaceId) {
      setSpaceTables([])
      setIsLoadingTables(false)
      setTablesError(null)
      return
    }

    let cancelled = false
    setIsLoadingTables(true)
    setTablesError(null)
    setSpaceTables([])

    void (async () => {
      try {
        const response = await TableApiService.getTablesBySpace(activeOrganizationId, activeSpaceId)
        if (cancelled) {
          return
        }
        setSpaceTables(response.tables)
      } catch (err) {
        if (cancelled) {
          return
        }
        setTablesError(err instanceof Error ? err.message : t('home.loadTablesFailed', { defaultValue: '加载空间表格失败' }))
      } finally {
        if (!cancelled) {
          setIsLoadingTables(false)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeSpaceId, activeOrganizationId, hasActiveOrganizationSpaceContext, t])

  const visibleTables = useMemo(
    () => spaceTables.filter((table) => table.visibility !== 'system'),
    [spaceTables]
  )

  const openTable = () => {
    const normalized = normalizeTableIdCandidate(tableId)
    if (!normalized) {
      setManualInputError(null)
      return
    }
    if (!isValidTableId(normalized)) {
      setManualInputError(
        t('home.invalidTableId', {
          defaultValue: '请输入真实的表 UUID，或直接从上方表列表进入。',
        })
      )
      return
    }
    setManualInputError(null)
    localStorage.setItem(LAST_TABLE_ID_KEY, normalized)
    navigate(buildResolvedTablePath(normalized))
  }

  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
          <span className="text-primary font-bold text-heading">T</span>
        </div>
        <h1 className="text-heading font-semibold text-foreground">
          {t('home.title')}
        </h1>
        <p className="text-muted-foreground">
          {t('home.subtitle', { name: displayName })}
        </p>
        </div>

        <div className="rounded-2xl border border-border bg-background p-6 shadow-sm">
          <div>
            <div className="text-title font-semibold text-foreground">
              {t('home.spaceTablesTitle', { defaultValue: 'Space 表格' })}
            </div>
            <p className="mt-2 text-body text-muted-foreground">
              {t('home.spaceTablesDesc', {
                defaultValue: '基于当前登录态自动拉取 workspace、space 和表列表，行为对齐 Electron。',
              })}
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="space-y-2">
                <div className="text-body text-muted-foreground">
                  {t('home.workspaceLabel', { defaultValue: 'Workspace' })}
                </div>
                <select
                  value={activeOrganizationId ?? ''}
                  onChange={(event) => {
                    const nextOrganizationId = event.target.value || null
                    setDetectedOrganizationId(nextOrganizationId)
                    setDetectedSpaceId(null)
                  }}
                  disabled={Boolean(organizationId) || Boolean(spaceId) || isLoadingContext || organizations.length === 0}
                  className="h-11 w-full rounded-xl border border-input bg-background px-4 text-body text-foreground outline-none transition focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {organizations.length === 0 ? (
                    <option value="">
                      {t('home.workspaceEmpty', { defaultValue: '暂无可用 workspace' })}
                    </option>
                  ) : null}
                  {organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="space-y-2">
                <div className="text-body text-muted-foreground">
                  {t('home.spaceLabel', { defaultValue: 'Space' })}
                </div>
                <select
                  value={activeSpaceId ?? ''}
                  onChange={(event) => {
                    setDetectedSpaceId(event.target.value || null)
                  }}
                  disabled={!activeOrganizationId || Boolean(spaceId) || isLoadingContext || spaces.length === 0}
                  className="h-11 w-full rounded-xl border border-input bg-background px-4 text-body text-foreground outline-none transition focus:border-primary disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {spaces.length === 0 ? (
                    <option value="">
                      {t('home.spaceEmpty', { defaultValue: '当前 workspace 没有 space' })}
                    </option>
                  ) : null}
                  {spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {isLoadingContext ? (
              <div className="mt-4 text-body text-muted-foreground">
                {t('home.loadingContext', { defaultValue: '正在加载 workspace / space...' })}
              </div>
            ) : null}

            {contextError ? (
              <div className="mt-4 text-body text-destructive">{contextError}</div>
            ) : null}
          </div>

          {hasActiveOrganizationSpaceContext ? (
            <>
              <div className="mt-4 rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-body text-muted-foreground">
                <div>{`organizationId: ${activeOrganizationId}`}</div>
                <div>{`spaceId: ${activeSpaceId}`}</div>
              </div>

              <div className="mt-4 space-y-3">
                {isLoadingTables ? (
                  <div className="text-body text-muted-foreground">
                    {t('home.loadingTables', { defaultValue: '正在加载表格列表...' })}
                  </div>
                ) : null}

                {tablesError ? (
                  <div className="text-body text-destructive">{tablesError}</div>
                ) : null}

                {!isLoadingTables && !tablesError && visibleTables.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border px-4 py-5 text-body text-muted-foreground">
                    {t('home.noTablesInSpace', { defaultValue: '这个 Space 里暂时没有可显示的表格。' })}
                  </div>
                ) : null}

                {visibleTables.map((table) => (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => {
                      localStorage.setItem(LAST_TABLE_ID_KEY, table.id)
                      navigate(buildResolvedTablePath(table.id))
                    }}
                    className="flex w-full items-center justify-between rounded-xl border border-border bg-background px-4 py-3 text-left transition hover:border-primary/40 hover:bg-muted/30"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-body font-medium text-foreground">
                        {table.icon ? `${table.icon} ${table.name}` : table.name}
                      </div>
                      <div className="mt-1 text-body text-muted-foreground">
                        {`${table.row_count ?? 0} rows · ${table.field_count ?? 0} fields`}
                      </div>
                    </div>
                    <div className="shrink-0 text-body text-primary">
                      {t('home.openTableInline', { defaultValue: '打开' })}
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          <div className={hasActiveOrganizationSpaceContext ? 'mt-8 border-t border-border/60 pt-6' : 'mt-8 border-t border-border/60 pt-6'}>
          <div className="text-title font-semibold text-foreground">
            {t('home.tableEntryTitle', { defaultValue: '兜底打开表格' })}
          </div>
          <p className="mt-2 text-body text-muted-foreground">
            {t('home.tableEntryDesc', {
              defaultValue: '正常应从上面的 Space 表列表进入；这里只保留给深链调试和异常兜底。',
            })}
          </p>

          {!hasActiveOrganizationSpaceContext ? (
            <div className="mt-3 text-body text-muted-foreground">
              {t('home.tableEntryHint', {
                defaultValue: '如果登录态还没拉到 workspace / space，可以临时手动输入真实 tableId。',
              })}
            </div>
          ) : null}

          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              value={tableId}
              onChange={(event) => {
                setTableId(event.target.value)
                if (manualInputError) {
                  setManualInputError(null)
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  openTable()
                }
              }}
              placeholder={t('home.tableIdPlaceholder', { defaultValue: '输入 tableId' })}
              className="h-11 flex-1 rounded-xl border border-input bg-background px-4 text-body text-foreground outline-none ring-0 transition focus:border-primary"
            />
            <button
              type="button"
              onClick={openTable}
              disabled={!tableId.trim()}
              className="h-11 rounded-xl bg-primary px-5 text-body font-medium text-primary-foreground transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('home.openTableButton', { defaultValue: '打开表格' })}
            </button>
          </div>
          {manualInputError ? (
            <div className="mt-3 text-body text-destructive">{manualInputError}</div>
          ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
