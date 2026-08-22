/**
 * 飞书导入选资源树：云盘我的空间 + 知识库，逐层懒加载。
 */
import React, { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Loader2, Table2 } from 'lucide-react'
import { Checkbox } from '@components/ui'
import { createLogger } from '@/utils/logger'
import { cn } from '@utils/cn'
import {
  getFeishuDriveRoot,
  listFeishuBitableTables,
  listFeishuDriveChildren,
  listFeishuWikiNodes,
  listFeishuWikiSpaces,
  type FeishuBrowseNode,
  type FeishuBitableTable,
} from './feishuApi'
import {
  docSelectionKey,
  getBitableTableSelectionState,
  getDirectResourceSelectionState,
  tableSelectionKey,
  type FeishuDirectSelectableResource,
} from './feishuImportPhase'

const log = createLogger('FeishuBrowseTree')

const ROOT_DRIVE = 'root:drive_my_space'
const ROOT_WIKI = 'root:wiki'

type KindFilter = 'all' | 'bitable' | 'docx'

export interface FeishuBrowseTreeProps {
  organizationId: string
  kindFilter: KindFilter
  selected: Set<string>
  disabled?: boolean
  onToggleTable: (appToken: string, tableId: string, checked: boolean, name?: string) => void
  onToggleTables: (appToken: string, tables: FeishuBitableTable[], checked: boolean) => void
  onToggleDoc: (docToken: string, checked: boolean, name?: string) => void
  /** 树内加载到的可读名称，供 Dialog 解析选中项标题（避免落成 token/table_id） */
  onNamesKnown?: (entries: Array<{ key: string; name: string }>) => void
  onError: (message: string) => void
}

function leafVisible(node: FeishuBrowseNode, kindFilter: KindFilter): boolean {
  if (!node.selectable) return true
  const kind = node.import_kind || node.node_kind
  if (kindFilter === 'all') return kind === 'bitable' || kind === 'docx'
  return kind === kindFilter
}

function isBitableNode(node: FeishuBrowseNode): boolean {
  return node.node_kind === 'bitable' || node.import_kind === 'bitable'
}

function nodeVisible(node: FeishuBrowseNode, kindFilter: KindFilter): boolean {
  return !node.selectable || leafVisible(node, kindFilter) || Boolean(node.has_child)
}

export const FeishuBrowseTree: React.FC<FeishuBrowseTreeProps> = ({
  organizationId,
  kindFilter,
  selected,
  disabled = false,
  onToggleTable,
  onToggleTables,
  onToggleDoc,
  onNamesKnown,
  onError,
}) => {
  const { t } = useTranslation('context')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [loadingIds, setLoadingIds] = useState<Set<string>>(() => new Set())
  const [bulkLoadingIds, setBulkLoadingIds] = useState<Set<string>>(() => new Set())
  const [childrenById, setChildrenById] = useState<Record<string, FeishuBrowseNode[]>>({})
  const [tablesByApp, setTablesByApp] = useState<Record<string, FeishuBitableTable[]>>({})
  const [driveRootToken, setDriveRootToken] = useState<string | null>(null)

  const setLoading = useCallback((id: string, on: boolean) => {
    setLoadingIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const publishLeafNames = useCallback((items: FeishuBrowseNode[]) => {
    if (!onNamesKnown) return
    const entries: Array<{ key: string; name: string }> = []
    for (const item of items) {
      if (!item.selectable || !item.token) continue
      const name = (item.name || '').trim()
      if (!name || name === item.token || name === item.node_token) continue
      if (item.import_kind === 'docx' || item.node_kind === 'docx') {
        entries.push({ key: docSelectionKey(item.token), name })
      } else if (item.import_kind === 'bitable' || item.node_kind === 'bitable') {
        // Base 名：供「App / table」展示；单表名在 load tables 后写入
        entries.push({ key: `app:${item.token}`, name })
      }
    }
    if (entries.length > 0) onNamesKnown(entries)
  }, [onNamesKnown])

  const loadChildren = useCallback(async (parentId: string, node?: FeishuBrowseNode) => {
    const needsBitableTables = Boolean(
      node && isBitableNode(node) && node.token && !tablesByApp[node.token],
    )
    if ((childrenById[parentId] && !needsBitableTables) || loadingIds.has(parentId)) return
    setLoading(parentId, true)
    try {
      if (parentId === ROOT_DRIVE) {
        let folderToken = driveRootToken
        if (!folderToken) {
          const root = await getFeishuDriveRoot(organizationId)
          folderToken = root.folder_token || root.token || null
          setDriveRootToken(folderToken)
        }
        if (!folderToken) throw new Error('无法获取云盘根目录')
        const page = await listFeishuDriveChildren(organizationId, folderToken)
        publishLeafNames(page.items)
        setChildrenById((prev) => ({ ...prev, [parentId]: page.items }))
        return
      }
      if (parentId === ROOT_WIKI) {
        const page = await listFeishuWikiSpaces(organizationId)
        setChildrenById((prev) => ({ ...prev, [parentId]: page.items }))
        return
      }
      if (!node) return
      if (node.node_kind === 'folder' && node.folder_token) {
        const page = await listFeishuDriveChildren(organizationId, node.folder_token)
        publishLeafNames(page.items)
        setChildrenById((prev) => ({ ...prev, [parentId]: page.items }))
        return
      }
      if (node.node_kind === 'wiki_space' && node.space_id) {
        const page = await listFeishuWikiNodes(organizationId, node.space_id)
        publishLeafNames(page.items)
        setChildrenById((prev) => ({ ...prev, [parentId]: page.items }))
        return
      }
      if (
        (node.node_kind === 'wiki_node' || node.has_child)
        && node.space_id
        && node.node_token
        && !(node.selectable && node.import_kind === 'bitable' && !node.has_child)
      ) {
        // 有 wiki 子节点时按节点展开；纯 bitable 叶子走表列表
        if (node.has_child) {
          const childRequest = childrenById[parentId]
            ? Promise.resolve({ items: childrenById[parentId] })
            : listFeishuWikiNodes(organizationId, node.space_id, node.node_token)
          const tableRequest = isBitableNode(node) && node.token && !tablesByApp[node.token]
            ? listFeishuBitableTables(organizationId, node.token)
            : Promise.resolve(null)
          const [childResult, tableResult] = await Promise.allSettled([childRequest, tableRequest])

          if (childResult.status === 'fulfilled') {
            publishLeafNames(childResult.value.items)
            setChildrenById((prev) => ({ ...prev, [parentId]: childResult.value.items }))
          } else {
            onError(childResult.reason instanceof Error ? childResult.reason.message : String(childResult.reason))
          }
          if (tableResult.status === 'fulfilled' && tableResult.value) {
            const tables = tableResult.value
            setTablesByApp((prev) => ({ ...prev, [node.token!]: tables }))
            onNamesKnown?.(
              tables
                .filter((row) => row.name && row.name !== row.table_id)
                .map((row) => ({
                  key: tableSelectionKey(node.token!, row.table_id),
                  name: row.name,
                })),
            )
          } else if (tableResult.status === 'rejected') {
            onError(tableResult.reason instanceof Error ? tableResult.reason.message : String(tableResult.reason))
          }
          return
        }
      }
      if (
        (node.node_kind === 'bitable' || node.import_kind === 'bitable')
        && node.token
      ) {
        if (node.name?.trim() && node.name !== node.token) {
          onNamesKnown?.([{ key: `app:${node.token}`, name: node.name.trim() }])
        }
        if (!tablesByApp[node.token]) {
          const tables = await listFeishuBitableTables(organizationId, node.token)
          setTablesByApp((prev) => ({ ...prev, [node.token!]: tables }))
          onNamesKnown?.(
            tables
              .filter((row) => row.name && row.name !== row.table_id)
              .map((row) => ({
                key: tableSelectionKey(node.token!, row.table_id),
                name: row.name,
              })),
          )
        }
        setChildrenById((prev) => ({ ...prev, [parentId]: [] }))
        return
      }
      setChildrenById((prev) => ({ ...prev, [parentId]: [] }))
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
      setChildrenById((prev) => ({ ...prev, [parentId]: [] }))
    } finally {
      setLoading(parentId, false)
    }
  }, [
    childrenById,
    driveRootToken,
    loadingIds,
    onError,
    onNamesKnown,
    organizationId,
    publishLeafNames,
    setLoading,
    tablesByApp,
  ])

  const toggleExpand = useCallback(async (id: string, node?: FeishuBrowseNode) => {
    const willExpand = !expanded.has(id)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    if (willExpand) {
      await loadChildren(id, node)
    }
  }, [expanded, loadChildren])

  const ensureBitableTables = useCallback(async (
    node: FeishuBrowseNode,
  ): Promise<FeishuBitableTable[] | null> => {
    if (!node.token) return null
    const cached = tablesByApp[node.token]
    if (cached) return cached

    setLoading(node.id, true)
    try {
      const tables = await listFeishuBitableTables(organizationId, node.token)
      setTablesByApp((prev) => ({ ...prev, [node.token!]: tables }))
      onNamesKnown?.(tables.map((table) => ({
        key: tableSelectionKey(node.token!, table.table_id),
        name: table.name,
      })))
      return tables
    } catch (err) {
      log.error('load direct bitable tables failed', { nodeId: node.id, err })
      onError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setLoading(node.id, false)
    }
  }, [onError, onNamesKnown, organizationId, setLoading, tablesByApp])

  const toggleBitableNode = useCallback(async (
    node: FeishuBrowseNode,
    checked: boolean,
  ) => {
    if (!node.token) return
    const tables = await ensureBitableTables(node)
    if (tables) onToggleTables(node.token, tables, checked)
  }, [ensureBitableTables, onToggleTables])

  const getDirectSelectableResources = (
    nodes: FeishuBrowseNode[],
  ): FeishuDirectSelectableResource[] => nodes.flatMap<FeishuDirectSelectableResource>((node) => {
    if (!node.selectable || !node.token || !leafVisible(node, kindFilter)) return []
    if (isBitableNode(node)) {
      const tables = tablesByApp[node.token]
      // 已加载且没有数据表的多维表不可导入，不参与直属资源的全选状态。
      if (tables?.length === 0) return []
      return [{
        kind: 'bitable' as const,
        token: node.token,
        name: node.name,
        tables,
      }]
    }
    if (node.node_kind === 'docx' || node.import_kind === 'docx') {
      return [{ kind: 'docx' as const, token: node.token, name: node.name }]
    }
    return []
  })

  const toggleDirectChildren = useCallback(async (
    parentId: string,
    nodes: FeishuBrowseNode[],
    checked: boolean,
  ) => {
    setBulkLoadingIds((prev) => new Set(prev).add(parentId))
    try {
      await Promise.all(nodes.map(async (node) => {
        if (!node.selectable || !node.token || !leafVisible(node, kindFilter)) return
        if (isBitableNode(node)) {
          const tables = await ensureBitableTables(node)
          if (tables) onToggleTables(node.token, tables, checked)
        } else if (node.node_kind === 'docx' || node.import_kind === 'docx') {
          onToggleDoc(node.token, checked, node.name)
        }
      }))
    } finally {
      setBulkLoadingIds((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
  }, [ensureBitableTables, kindFilter, onToggleDoc, onToggleTables])

  const renderDirectSelectionControl = (parentId: string, nodes: FeishuBrowseNode[]) => {
    const resources = getDirectSelectableResources(nodes)
    if (resources.length === 0) return null

    const selectionState = getDirectResourceSelectionState(selected, resources)
    const checked = selectionState === 'checked'
      ? true
      : selectionState === 'indeterminate'
        ? 'indeterminate' as const
        : false
    const bulkLoading = bulkLoadingIds.has(parentId)
    const controlDisabled = disabled || bulkLoading
    const shouldSelect = selectionState !== 'checked'
    const label = selectionState === 'checked'
      ? t('home.assetBrowser.feishuBrowseDeselectDirect', { defaultValue: '取消全选' })
      : t('home.assetBrowser.feishuBrowseSelectDirect', { defaultValue: '全选' })

    return (
      <label
        className={cn(
          'flex shrink-0 cursor-pointer items-center gap-1.5 pr-2 text-caption text-muted-foreground/80',
          controlDisabled && 'pointer-events-none opacity-60',
        )}
        aria-busy={bulkLoading}
      >
        <Checkbox
          checked={checked}
          disabled={controlDisabled}
          aria-label={label}
          onCheckedChange={() => void toggleDirectChildren(parentId, nodes, shouldSelect)}
        />
        <span>{label}</span>
      </label>
    )
  }

  const renderSectionHeader = (label: string, count: number | null, depth: number) => (
    <div
      className="px-2 pt-2 text-caption text-muted-foreground/60"
      style={{ paddingLeft: 12 + depth * 14 }}
    >
      {count == null ? label : `${label} · ${count}`}
    </div>
  )

  const renderTableLeaves = (appToken: string, depth: number, isLoading: boolean) => {
    const tables = tablesByApp[appToken] || []
    if (isLoading) {
      return (
        <div
          className="flex items-center gap-2 px-2 py-1.5 text-caption text-muted-foreground/60"
          style={{ paddingLeft: 12 + depth * 14 }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('home.assetBrowser.feishuBrowseLoadingTables', { defaultValue: '正在加载数据表…' })}
        </div>
      )
    }
    if (tables.length === 0) {
      return (
        <div
          className="px-2 py-1.5 text-caption text-muted-foreground/60"
          style={{ paddingLeft: 12 + depth * 14 }}
        >
          —
        </div>
      )
    }
    return tables.map((table) => {
      const key = tableSelectionKey(appToken, table.table_id)
      const checked = selected.has(key)
      const tableDisabled = disabled
      return (
        <label
          key={key}
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5',
            'hover:bg-foreground/[0.04]',
            tableDisabled && 'pointer-events-none opacity-60',
          )}
          style={{ paddingLeft: 12 + depth * 14 }}
        >
            <Checkbox
              checked={checked}
              disabled={tableDisabled}
              onCheckedChange={(v) => (
                onToggleTable(appToken, table.table_id, v === true, table.name || undefined)
              )}
            />
            <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            <span className="truncate text-body text-foreground/80">
              {table.name}
            </span>
            <span className="ml-auto shrink-0 text-caption text-muted-foreground/60">
              {t('home.assetBrowser.feishuBrowseTableKind', { defaultValue: '数据表' })}
            </span>
          </label>
      )
    })
  }

  const renderNode = (node: FeishuBrowseNode, depth: number): React.ReactNode => {
    const visibleChildren = (childrenById[node.id] || [])
      .filter((child) => nodeVisible(child, kindFilter))
    const hidesFilteredPath = node.selectable
      && !leafVisible(node, kindFilter)
      && node.has_child
      && Object.prototype.hasOwnProperty.call(childrenById, node.id)
      && visibleChildren.length === 0
    if (!nodeVisible(node, kindFilter) || hidesFilteredPath) return null

    const isOpen = expanded.has(node.id)
    const loading = loadingIds.has(node.id)
    const isBitable = isBitableNode(node)
    const isDocx = node.node_kind === 'docx' || node.import_kind === 'docx'
    const canExpand = node.expandable || isBitable
    const showsSelection = leafVisible(node, kindFilter)

    if (isDocx && node.token && node.selectable) {
      const key = docSelectionKey(node.token)
      const checked = selected.has(key)
      const docDisabled = disabled || !showsSelection
      return (
        <div key={node.id}>
          <div
            className="flex items-center gap-1 rounded-md hover:bg-foreground/[0.04]"
            style={{ paddingLeft: 4 + depth * 14 }}
          >
            {node.has_child ? (
              <button
                type="button"
                className="flex h-8 w-6 shrink-0 items-center justify-center"
                disabled={disabled}
                onClick={() => void toggleExpand(node.id, node)}
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                ) : isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </button>
            ) : (
              <span className="w-6 shrink-0" />
            )}
            <label
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pr-2',
                docDisabled && 'pointer-events-none opacity-60',
              )}
            >
              {showsSelection ? (
                <Checkbox
                  checked={checked}
                  disabled={docDisabled}
                  onCheckedChange={(v) => (
                    onToggleDoc(
                      node.token!,
                      v === true,
                      node.name && node.name !== node.token ? node.name : undefined,
                    )
                  )}
                />
              ) : <span className="h-4 w-4 shrink-0" />}
              <span className="min-w-0 flex-1 truncate text-body text-foreground/90">
                {node.name}
              </span>
            </label>
            {isOpen && !loading
              ? renderDirectSelectionControl(node.id, visibleChildren)
              : null}
          </div>
          {isOpen && node.has_child
            ? visibleChildren.map((child) => renderNode(child, depth + 1))
            : null}
        </div>
      )
    }

    if (isBitable && node.token && node.selectable) {
      const tables = tablesByApp[node.token] || []
      const selectionState = getBitableTableSelectionState(selected, node.token, tables)
      const parentChecked = selectionState === 'checked'
        ? true
        : selectionState === 'indeterminate'
          ? 'indeterminate' as const
          : false
      const parentDisabled = disabled
        || loading
        || !showsSelection
      return (
        <div key={node.id}>
          <div
            className="flex items-center gap-1 rounded-md px-1 hover:bg-foreground/[0.04]"
            style={{ paddingLeft: 4 + depth * 14 }}
          >
            <button
              type="button"
              className="flex h-8 w-6 shrink-0 items-center justify-center"
              disabled={disabled}
              onClick={() => void toggleExpand(node.id, node)}
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : isOpen ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
            </button>
            {showsSelection ? (
              <Checkbox
                checked={parentChecked}
                disabled={parentDisabled}
                onCheckedChange={() => void toggleBitableNode(
                  node,
                  selectionState !== 'checked',
                )}
              />
            ) : <span className="h-4 w-4 shrink-0" />}
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1 py-1.5 text-left"
              disabled={disabled}
              onClick={() => void toggleExpand(node.id, node)}
            >
              <span className="min-w-0 flex-1 truncate text-body text-foreground/90">
                {node.name}
              </span>
              <span className="shrink-0 text-caption text-muted-foreground/60">
                {t('home.assetBrowser.feishuKindBitable', { defaultValue: '多维表格' })}
              </span>
            </button>
            {isOpen && !loading
              ? renderDirectSelectionControl(node.id, visibleChildren)
              : null}
          </div>
          {isOpen ? (
            <>
              {kindFilter !== 'docx' ? (
                <>
                  {renderSectionHeader(
                    t('home.assetBrowser.feishuBrowseTables', { defaultValue: '数据表' }),
                    loading ? null : tables.length,
                    depth + 1,
                  )}
                  {renderTableLeaves(node.token, depth + 2, loading)}
                </>
              ) : null}
              {node.has_child && (loading || visibleChildren.length > 0)
                ? (
                    <>
                      {renderSectionHeader(
                        t('home.assetBrowser.feishuBrowseChildPages', { defaultValue: '下级资源' }),
                        loading
                          ? null
                          : visibleChildren.length,
                        depth + 1,
                      )}
                      {visibleChildren.map((child) => renderNode(child, depth + 2))}
                    </>
                  )
                : null}
            </>
          ) : null}
        </div>
      )
    }

    // 容器：folder / wiki_space / wiki_node
    return (
      <div key={node.id}>
        <div className="flex items-center rounded-md hover:bg-foreground/[0.04]">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1.5 text-left"
            style={{ paddingLeft: 4 + depth * 14 }}
            disabled={disabled || !canExpand}
            onClick={() => void toggleExpand(node.id, node)}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : isOpen ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate text-body text-foreground/90">
              {node.name}
            </span>
          </button>
          {isOpen && !loading
            ? renderDirectSelectionControl(node.id, visibleChildren)
            : null}
        </div>
        {isOpen
          ? (childrenById[node.id] || [])
            .filter((child) => nodeVisible(child, kindFilter))
            .map((child) => renderNode(child, depth + 1))
          : null}
        {isOpen && !loading && (childrenById[node.id]?.length ?? 0) === 0 ? (
          <div
            className="px-2 py-1.5 text-caption text-muted-foreground/60"
            style={{ paddingLeft: 12 + (depth + 1) * 14 }}
          >
            {t('home.assetBrowser.feishuBrowseEmpty', { defaultValue: '此目录下暂无可导入项' })}
          </div>
        ) : null}
      </div>
    )
  }

  const roots = [
    {
      id: ROOT_DRIVE,
      name: t('home.assetBrowser.feishuBrowseDriveRoot', {
        defaultValue: '云盘 · 我的空间',
      }),
    },
    {
      id: ROOT_WIKI,
      name: t('home.assetBrowser.feishuBrowseWikiRoot', {
        defaultValue: '知识库 · 我的文档库与空间',
      }),
    },
  ]

  return (
    <div className="p-1">
      {roots.map((root) => {
        const isOpen = expanded.has(root.id)
        const loading = loadingIds.has(root.id)
        const visibleChildren = (childrenById[root.id] || [])
          .filter((child) => nodeVisible(child, kindFilter))
        return (
          <div key={root.id}>
            <div className="flex items-center rounded-md hover:bg-foreground/[0.04]">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                disabled={disabled}
                onClick={() => void toggleExpand(root.id)}
              >
                {loading ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground/90">
                  {root.name}
                </span>
              </button>
              {isOpen && !loading
                ? renderDirectSelectionControl(root.id, visibleChildren)
                : null}
            </div>
            {isOpen
              ? visibleChildren.map((child) => renderNode(child, 1))
              : null}
            {isOpen && !loading && (childrenById[root.id]?.length ?? 0) === 0 ? (
              <div className="px-3 py-2 text-caption text-muted-foreground/60">
                {t('home.assetBrowser.feishuBrowseEmpty', {
                  defaultValue: '此目录下暂无可导入项',
                })}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
