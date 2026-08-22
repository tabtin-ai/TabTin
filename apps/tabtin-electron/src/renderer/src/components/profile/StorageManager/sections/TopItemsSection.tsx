/**
 * TopItemsSection — "占空间最多的" Top 列表（v3：行可展开看 Space/env/文件 细分）。
 *
 * 设计取舍（v3，2026-05 减压重设第二轮）：
 *   - 顶层行 = 数据类型（"对话与操作记录" / "浏览器登录环境" / "录屏"...）
 *   - 复合行（有 drillItems）可点击展开抽屉，看按 Space/env/文件 的细分
 *   - 单行（无 drillItems）直接显示清按钮，点击 = 清理对话框
 *   - 「其他工作区」等聚合行视觉淡化，避免和真实命名实体混淆
 *
 * 与性能面板 SpaceGroup 的呼应：
 *   - 父子层级（性能面板：Space → 终端；存储：数据类型 → Space/env/文件）
 *   - 子层用缩进 + 左边框视觉
 *   - 点击主行展开/收起
 */

import React, { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  Bookmark,
  ChevronRight,
  Download,
  FolderKanban,
  GitCommit,
  Globe,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  Package,
  Sparkles,
  Trash2,
  Video,
} from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { SettingsSectionCard } from '../../../settings/SettingsSectionCard'
import { SETTINGS_FIELD_TITLE, SETTINGS_HINT } from '../../../settings/settingsUi'
import { ClearConfirmDialog } from '../components/ClearConfirmDialog'
import { formatBytes } from '../components/types'
import type {
  BucketDescriptor,
  ClearHandler,
  ClearOptions,
  ExportHandler,
  ListItemsHandler,
} from '../components/types'
import type {
  StorageDrillItem,
  StorageTopItem,
  TopItemKind,
} from '../utils/buildTopItems'

interface TopItemsSectionProps {
  topItems: StorageTopItem[]
  allItems: StorageTopItem[]
  isLoading: boolean
  onClear: ClearHandler
  onListItems: ListItemsHandler
  onExport: ExportHandler
  onChanged?: () => void
}

/** kind → 图标 */
const KIND_ICON: Record<TopItemKind, React.ComponentType<{ className?: string }>> = {
  'conversation-bundle': MessageSquare,
  'checkpoint-bundle': GitCommit,
  'browser-env-bundle': Globe,
  'media-folder': Video,
  'agent-download': Download,
  'app-project': FolderKanban,
  'app-bundle': Package,
  'browser-asset': Bookmark,
  'voice-settings': Mic,
  'cache-bundle': Sparkles,
}

function resolveItemIcon(item: StorageTopItem): React.ComponentType<{ className?: string }> {
  if (item.kind === 'media-folder') {
    const id = item.bucketIds[0] ?? ''
    if (id.includes('screenshot')) return ImageIcon
    if (id.includes('pdf') || id.includes('exports')) return Package
    return Video
  }
  if (item.kind === 'app-project') {
    const id = item.bucketIds[0] ?? ''
    if (id.startsWith('tabdoc:')) return FolderKanban
  }
  if (item.kind === 'browser-asset') return AppWindow
  return KIND_ICON[item.kind] ?? Package
}

export const TopItemsSection: React.FC<TopItemsSectionProps> = ({
  topItems,
  allItems,
  isLoading,
  onClear,
  onListItems: _onListItems,
  onExport: _onExport,
  onChanged,
}) => {
  const { t } = useTranslation('storage-manager')
  const [showAll, setShowAll] = useState(false)

  const restItems = useMemo(() => {
    const topIds = new Set(topItems.map((it) => it.id))
    return allItems.filter((it) => !topIds.has(it.id))
  }, [allItems, topItems])

  if (isLoading) {
    return (
      <section className="space-y-2" data-testid="top-items-loading">
        <h3 className={SETTINGS_FIELD_TITLE}>
          {t('section.topItemsTitle', { defaultValue: '占空间最多的' })}
        </h3>
        <SettingsSectionCard>
          <div className="flex items-center gap-2 py-2 text-body text-muted-foreground/60">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('topItems.loading', {
              defaultValue: '正在统计你的工作区数据…',
            })}
          </div>
        </SettingsSectionCard>
      </section>
    )
  }

  if (topItems.length === 0) {
    return (
      <section className="space-y-2" data-testid="top-items-empty">
        <h3 className={SETTINGS_FIELD_TITLE}>
          {t('section.topItemsTitle', { defaultValue: '占空间最多的' })}
        </h3>
        <SettingsSectionCard>
          <p className={SETTINGS_HINT}>
            {t('topItems.empty', {
              defaultValue: '还没什么数据，用一段时间后再来看看。',
            })}
          </p>
        </SettingsSectionCard>
      </section>
    )
  }

  return (
    <section className="space-y-2" data-testid="top-items-section">
      <h3 className={SETTINGS_FIELD_TITLE}>
        {t('section.topItemsTitle', { defaultValue: '占空间最多的' })}
      </h3>

      <SettingsSectionCard>
        <div className="space-y-0.5 -mx-1">
          {topItems.map((item) => (
            <TopItemRow
              key={item.id}
              item={item}
              onClear={onClear}
              onChanged={onChanged}
            />
          ))}
        </div>
      </SettingsSectionCard>

      {restItems.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="flex items-center gap-1.5 text-caption text-muted-foreground/60 hover:text-foreground transition-colors duration-150 px-1"
            aria-expanded={showAll}
            data-testid="top-items-show-all"
          >
            <ChevronRight
              className={cn(
                'h-3 w-3 transition-transform duration-150',
                showAll && 'rotate-90',
              )}
            />
            {showAll
              ? t('topItems.collapseAll', { defaultValue: '收起' })
              : t('topItems.showAll', {
                  count: restItems.length,
                  defaultValue: '查看其余 {{count}} 项',
                })}
          </button>
          {showAll && (
            <SettingsSectionCard>
              <div className="space-y-0.5 -mx-1">
                {restItems.map((item) => (
                  <TopItemRow
                    key={item.id}
                    item={item}
                    onClear={onClear}
                    onChanged={onChanged}
                  />
                ))}
              </div>
            </SettingsSectionCard>
          )}
        </>
      )}
    </section>
  )
}

// ── 顶层行 ────────────────────────────────────────────────────────

interface TopItemRowProps {
  item: StorageTopItem
  onClear: ClearHandler
  onChanged?: () => void
}

const TopItemRow: React.FC<TopItemRowProps> = ({ item, onClear, onChanged }) => {
  const { t } = useTranslation('storage-manager')
  const [expanded, setExpanded] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const Icon = resolveItemIcon(item)

  const hasDrill = (item.drillItems?.length ?? 0) > 0
  const canShowClearButton = item.canClear && !hasDrill // 复合行需展开后单清

  // 单行清的虚拟 descriptor + clear handler
  const fakeDescriptor = useMemo<BucketDescriptor>(() => buildFakeDescriptor(item), [item])
  const fakeSize = useMemo(
    () => ({
      id: fakeDescriptor.id,
      bytes: item.bytes,
      itemCount: item.itemCount,
      measuredAt: 0,
    }),
    [fakeDescriptor.id, item.bytes, item.itemCount],
  )

  const handleClear = async () => {
    setBusy(true)
    let freed = 0
    let count = 0
    const errors: string[] = []
    try {
      for (const bucketId of item.bucketIds) {
        try {
          const r = await onClear(bucketId)
          freed += r.freedBytes
          count += r.clearedItemCount
        } catch (err) {
          errors.push(`${bucketId}: ${(err as Error).message ?? 'unknown'}`)
        }
      }
      onChanged?.()
    } finally {
      setBusy(false)
    }
    return {
      id: fakeDescriptor.id,
      dryRun: false,
      clearedItemCount: count,
      freedBytes: freed,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  return (
    <div className="relative" data-testid={`top-item-${item.kind}`}>
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-2 rounded-md transition-colors duration-150 group',
          hasDrill && 'cursor-pointer hover:bg-muted/15',
          !hasDrill && 'hover:bg-muted/10',
        )}
        onClick={hasDrill ? () => setExpanded((v) => !v) : undefined}
        role={hasDrill ? 'button' : undefined}
        tabIndex={hasDrill ? 0 : undefined}
        aria-expanded={hasDrill ? expanded : undefined}
      >
        {hasDrill ? (
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground/80">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-body text-foreground truncate">{item.label}</div>
          {item.subtitle && (
            <div className="text-caption text-muted-foreground/60 truncate">
              {item.subtitle}
            </div>
          )}
        </div>
        <span className="shrink-0 text-body tabular-nums text-muted-foreground">
          {formatBytes(item.bytes)}
        </span>
        {canShowClearButton && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation()
              setConfirmOpen(true)
            }}
            aria-label={t('actions.clear', { defaultValue: '清理' })}
            className={cn(
              'h-7 w-7 p-0 shrink-0 text-muted-foreground/60 hover:text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity',
              item.kind === 'cache-bundle' && 'opacity-100 text-success hover:text-success',
            )}
            data-testid={`top-item-clear-${item.kind}`}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
      </div>

      {hasDrill && expanded && item.drillItems && (
        <div className="ml-5 border-l border-border/30 pl-2 my-1 space-y-0.5">
          {item.drillItems.map((drill) => (
            <DrillRow
              key={drill.id}
              parentItem={item}
              drill={drill}
              onClear={onClear}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {confirmOpen && (
        <ClearConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          descriptor={fakeDescriptor}
          size={fakeSize}
          onClear={handleClear}
        />
      )}
    </div>
  )
}

// ── 下钻行（缩进的子行） ──────────────────────────────────────────

interface DrillRowProps {
  parentItem: StorageTopItem
  drill: StorageDrillItem
  onClear: ClearHandler
  onChanged?: () => void
}

const DrillRow: React.FC<DrillRowProps> = ({
  parentItem,
  drill,
  onClear,
  onChanged,
}) => {
  const { t } = useTranslation('storage-manager')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const isOther = drill.id.endsWith('__other__') || drill.id === '__other__'

  const fakeDescriptor = useMemo<BucketDescriptor>(
    () => buildFakeDrillDescriptor(parentItem, drill, isOther),
    [parentItem, drill, isOther],
  )
  const fakeSize = useMemo(
    () => ({
      id: fakeDescriptor.id,
      bytes: drill.bytes,
      itemCount: drill.itemCount,
      measuredAt: 0,
    }),
    [fakeDescriptor.id, drill.bytes, drill.itemCount],
  )

  const handleClear = async () => {
    setBusy(true)
    let freed = 0
    let count = 0
    const errors: string[] = []
    try {
      if (drill.itemRefs && drill.itemRefs.length > 0) {
        // 按 bucket 分组 itemIds 定向清
        const byBucket = new Map<string, string[]>()
        for (const ref of drill.itemRefs) {
          const arr = byBucket.get(ref.bucketId) ?? []
          arr.push(ref.itemId)
          byBucket.set(ref.bucketId, arr)
        }
        for (const [bucketId, ids] of byBucket.entries()) {
          try {
            const r = await onClear(bucketId, { itemIds: ids } as ClearOptions)
            freed += r.freedBytes
            count += r.clearedItemCount
          } catch (err) {
            errors.push(`${bucketId}: ${(err as Error).message ?? 'unknown'}`)
          }
        }
      } else {
        // 单 bucket 整清
        for (const bucketId of drill.bucketIds) {
          try {
            const r = await onClear(bucketId)
            freed += r.freedBytes
            count += r.clearedItemCount
          } catch (err) {
            errors.push(`${bucketId}: ${(err as Error).message ?? 'unknown'}`)
          }
        }
      }
      onChanged?.()
    } finally {
      setBusy(false)
    }
    return {
      id: fakeDescriptor.id,
      dryRun: false,
      clearedItemCount: count,
      freedBytes: freed,
      errors: errors.length > 0 ? errors : undefined,
    }
  }

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-muted/10 transition-colors group"
      data-testid="top-item-drill-row"
    >
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'text-body truncate',
            isOther
              ? 'text-muted-foreground/60 italic'
              : 'text-foreground/80',
          )}
        >
          {drill.label}
        </div>
        {drill.itemCount && drill.itemCount > 1 && (
          <div className="text-caption text-muted-foreground/60 truncate">
            {t('topItems.itemCount', {
              count: drill.itemCount,
              defaultValue: '{{count}} 项',
            })}
          </div>
        )}
      </div>
      <span className="shrink-0 text-caption tabular-nums text-muted-foreground/80">
        {formatBytes(drill.bytes)}
      </span>
      {drill.canClear && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => setConfirmOpen(true)}
          aria-label={t('actions.clear', { defaultValue: '清理' })}
          className="h-6 w-6 p-0 shrink-0 text-muted-foreground/60 hover:text-destructive opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Trash2 className="h-3 w-3" />
          )}
        </Button>
      )}
      {confirmOpen && (
        <ClearConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          descriptor={fakeDescriptor}
          size={fakeSize}
          onClear={handleClear}
        />
      )}
    </div>
  )
}

// ── 虚拟 descriptor 工厂 ─────────────────────────────────────────

/** 顶层行 = ClearConfirmDialog 的 descriptor */
function buildFakeDescriptor(item: StorageTopItem): BucketDescriptor {
  return {
    id: `top::${item.id}`,
    category:
      item.kind === 'cache-bundle'
        ? 'cache'
        : item.confirmationLevel === 'L2'
          ? 'semi-cache'
          : 'data',
    group: mapKindToGroup(item.kind),
    displayName: item.label,
    description: item.subtitle ?? '',
    requiresConfirmation:
      item.confirmationLevel === 'L1'
        ? 'none'
        : item.confirmationLevel === 'L2' || item.confirmationLevel.startsWith('L3')
          ? 'soft'
          : 'hard',
    hideFromList: false,
    capabilities: {
      canList: false,
      canClear: item.canClear,
      canExport: false,
    },
  }
}

/** 下钻行 descriptor —— 标题里带父类型暗示（"对话与操作记录 · midscene"） */
function buildFakeDrillDescriptor(
  parent: StorageTopItem,
  drill: StorageDrillItem,
  isOther: boolean,
): BucketDescriptor {
  return {
    id: `drill::${parent.id}::${drill.id}`,
    category:
      parent.kind === 'cache-bundle'
        ? 'cache'
        : drill.confirmationLevel === 'L2'
          ? 'semi-cache'
          : 'data',
    group: mapKindToGroup(parent.kind),
    displayName: isOther ? drill.label : `${drill.label} · ${parent.label}`,
    description: '',
    requiresConfirmation:
      drill.confirmationLevel === 'L1'
        ? 'none'
        : drill.confirmationLevel === 'L2' || drill.confirmationLevel.startsWith('L3')
          ? 'soft'
          : 'hard',
    hideFromList: false,
    capabilities: {
      canList: false,
      canClear: drill.canClear,
      canExport: false,
    },
  }
}

function mapKindToGroup(kind: TopItemKind): BucketDescriptor['group'] {
  switch (kind) {
    case 'conversation-bundle':
      return 'conversation'
    case 'checkpoint-bundle':
      return 'checkpoint'
    case 'browser-env-bundle':
    case 'browser-asset':
      return 'browser'
    case 'media-folder':
    case 'agent-download':
      return 'media'
    case 'app-project':
    case 'app-bundle':
      return 'business-app'
    case 'voice-settings':
      return 'system'
    case 'cache-bundle':
      return 'cache'
    default:
      return 'business-app'
  }
}

export default TopItemsSection
