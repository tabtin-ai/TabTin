/**
 * 结构化封面预览组件 —— 为每种 App 类型提供视觉化的卡片封面。
 *
 * 设计原则：
 *   - 视觉辨识度 > 信息密度 —— 用户扫一眼就能区分 App 类型
 *   - 主体使用 CSS/SVG，不依赖外部资源
 *     （例外：TinsPreview 当插件有品牌 icon_url 时以 <img> 展示）
 *   - 统一高度 h-24 (96px)，宽度由父容器决定
 *
 * 扩展方式：
 *   1. 新建 Preview 组件
 *   2. 在底部 coverBuilders 注册表中添加对应 builder 函数
 */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { COVER_TEXT_MAX_CHARS, TABDATA_COVER_MAX_COLS } from '../../constants'
import { metaStr, metaNum, metaBool, metaStrArr, metaNumOr } from './metaFieldUtils'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'

// ─── TabData: 迷你表格 ─── header + placeholder data rows ────────────────────

const CELL_W = [
  [72, 48, 85, 60],
  [55, 70, 40, 78],
  [80, 35, 65, 50],
]

export const TabDataPreview: React.FC<{
  fieldNames: string[]
  rowCount: number
}> = ({ fieldNames, rowCount }) => {
  const { t } = useTranslation('context')
  const cols = fieldNames.slice(0, TABDATA_COVER_MAX_COLS)
  if (!cols.length) return null
  return (
    <div className="flex h-full flex-col gap-[2px] px-2 pt-2 pb-1">
      <div className="flex gap-[1px] shrink-0">
        {cols.map((n, i) => (
          <div
            key={i}
            // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
            className="flex-1 truncate rounded-sm bg-foreground/[0.07] px-1 py-[2px] text-[7.5px] font-medium leading-tight text-foreground/40"
          >
            {n}
          </div>
        ))}
      </div>
      {CELL_W.map((ws, ri) => (
        <div key={ri} className="flex gap-[1px]" style={{ opacity: 0.85 - ri * 0.2 }}>
          {cols.map((_, ci) => (
            <div key={ci} className="flex-1 px-1 py-[2px]">
              <div
                className="h-[3px] rounded-full bg-foreground/[0.06]"
                style={{ width: `${ws[ci % ws.length]}%` }}
              />
            </div>
          ))}
        </div>
      ))}
      {rowCount > 0 && (
        <div
          // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
          className="mt-auto text-[7px] text-foreground/20 tabular-nums"
        >
          {t('preview.coverRows', { count: rowCount })}
        </div>
      )}
    </div>
  )
}

// ─── TabSlide: 堆叠幻灯片 ──────────────────────────────────────────────────

export const TabSlidePreview: React.FC<{ pageCount: number }> = ({ pageCount }) => {
  const { t } = useTranslation('context')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1">
      <div className="relative">
        {pageCount > 2 && (
          <div className="absolute -bottom-1 left-1/2 h-9 w-14 -translate-x-1/2 rounded-[2px] border border-foreground/[0.06] bg-foreground/[0.02]" />
        )}
        {pageCount > 1 && (
          <div className="absolute -bottom-[3px] left-1/2 h-9 w-[58px] -translate-x-1/2 rounded-[2px] border border-foreground/[0.06] bg-foreground/[0.03]" />
        )}
        <div className="relative flex h-9 w-[62px] items-center justify-center rounded-[3px] border border-foreground/[0.1] bg-background/60">
          <div className="space-y-[2px] px-2">
            <div className="h-[3px] w-8 rounded-full bg-foreground/[0.1]" />
            <div className="h-[2px] w-6 rounded-full bg-foreground/[0.06]" />
            <div className="h-[2px] w-7 rounded-full bg-foreground/[0.06]" />
          </div>
        </div>
      </div>
      <span className={cn('mt-1', 'text-foreground/25', CANVAS_TEXT_META)}>{t('preview.coverPages', { count: pageCount })}</span>
    </div>
  )
}

// ─── TabCode: 代码行 ────────────────────────────────────────────────────────

export const TabCodePreview: React.FC<{ projectName?: string }> = ({ projectName }) => (
  <div className="flex h-full flex-col gap-[3px] px-2.5 pt-2 pb-1">
    <div className="flex gap-1">
      <div className="h-[3px] w-5 rounded-full bg-purple-500/20" />
      <div className="h-[3px] w-10 rounded-full bg-foreground/[0.08]" />
    </div>
    <div className="flex gap-1 pl-2">
      <div className="h-[3px] w-4 rounded-full bg-blue-500/20" />
      <div className="h-[3px] w-3 rounded-full bg-foreground/[0.06]" />
      <div className="h-[3px] w-6 rounded-full bg-green-500/15" />
    </div>
    <div className="flex gap-1 pl-2">
      <div className="h-[3px] w-7 rounded-full bg-foreground/[0.06]" />
      <div className="h-[3px] w-4 rounded-full bg-orange-500/15" />
    </div>
    <div className="flex gap-1 pl-4">
      <div className="h-[3px] w-5 rounded-full bg-blue-500/15" />
      <div className="h-[3px] w-4 rounded-full bg-foreground/[0.05]" />
    </div>
    <div className="h-[3px] w-3 rounded-full bg-purple-500/15" />
    {projectName && (
      <div
        // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
        className="mt-auto truncate text-[7px] text-foreground/20"
      >
        {projectName}
      </div>
    )}
  </div>
)

// ─── TabSite: 浏览器窗口 ────────────────────────────────────────────────────

export const TabSitePreview: React.FC<{
  url?: string
  framework?: string
}> = ({ url, framework }) => (
  <div className="flex h-full flex-col px-2 pt-1.5 pb-1">
    <div className="flex items-center gap-1 pb-1">
      <div className="flex gap-[3px]">
        <div className="h-[5px] w-[5px] rounded-full bg-red-400/30" />
        <div className="h-[5px] w-[5px] rounded-full bg-yellow-400/30" />
        <div className="h-[5px] w-[5px] rounded-full bg-green-400/30" />
      </div>
      <div className="flex h-[10px] flex-1 items-center rounded-sm bg-foreground/[0.04] px-1">
        {url && (
          <span
            // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
            className="truncate text-[6px] text-foreground/20"
          >
            {url}
          </span>
        )}
      </div>
    </div>
    <div className="flex-1 rounded-sm border border-foreground/[0.06] bg-foreground/[0.01] p-1.5">
      <div className="space-y-[3px]">
        <div className="h-[3px] w-3/4 rounded-full bg-foreground/[0.06]" />
        <div className="h-[2px] w-full rounded-full bg-foreground/[0.04]" />
        <div className="h-[2px] w-5/6 rounded-full bg-foreground/[0.04]" />
        <div className="h-[2px] w-2/3 rounded-full bg-foreground/[0.04]" />
      </div>
    </div>
    {framework && (
      <div
        // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
        className="mt-0.5 text-[7px] text-foreground/20"
      >
        {framework}
      </div>
    )}
  </div>
)

// ─── TabDoc: 迷你文档页面 ───────────────────────────────────────────────────

export const TabDocPreview: React.FC<{
  text?: string | null
  icon?: string
  version?: number
}> = ({ text, icon, version }) => {
  const hasText = !!text?.trim()
  return (
    <div className="flex h-full flex-col px-2.5 pt-1.5 pb-1">
      {/* 页面模拟 */}
      <div className="relative flex-1 overflow-hidden rounded-[3px] border border-foreground/[0.06] bg-background/60 px-2 pt-1.5 pb-1">
        {/* 文档图标 + 标题行 */}
        <div className="mb-1 flex items-center gap-1">
          {icon && <span className={cn('leading-none', CANVAS_TEXT_MICRO)}>{icon}</span>}
          <div className="h-[4px] w-10 rounded-full bg-foreground/[0.12]" />
        </div>
        {hasText ? (
          <p
            // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
            className="line-clamp-3 text-[7px] leading-[1.45] text-foreground/35"
          >
            {text!.slice(0, COVER_TEXT_MAX_CHARS)}
          </p>
        ) : (
          <div className="space-y-[3px]">
            <div className="h-[2.5px] w-full rounded-full bg-foreground/[0.05]" />
            <div className="h-[2.5px] w-5/6 rounded-full bg-foreground/[0.05]" />
            <div className="h-[2.5px] w-4/6 rounded-full bg-foreground/[0.04]" />
            <div className="mt-1 h-[2.5px] w-full rounded-full bg-foreground/[0.04]" />
            <div className="h-[2.5px] w-3/4 rounded-full bg-foreground/[0.03]" />
          </div>
        )}
      </div>
      {/* 版本角标 */}
      {!hasText && version != null && version > 0 && (
        <div
          // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
          className="mt-0.5 text-right text-[7px] text-foreground/20"
        >
          v{version}
        </div>
      )}
    </div>
  )
}


// ─── TabFolder: 文件夹 ────────────────────────────────────────────────────────

export const TabFolderPreview: React.FC<{
  folderName?: string
}> = ({ folderName }) => (
  <div className="flex h-full flex-col items-center justify-center gap-1.5">
    <svg width="48" height="38" viewBox="0 0 48 38" className="text-foreground/[0.15]">
      <path d="M2 8 L2 32 C2 33.5 3 34.5 4.5 34.5 L43.5 34.5 C45 34.5 46 33.5 46 32 L46 12 C46 10.5 45 9.5 43.5 9.5 L22 9.5 L18 5.5 L4.5 5.5 C3 5.5 2 6.5 2 8Z" fill="currentColor" opacity="0.35" />
      <rect x="8" y="16" width="16" height="2" rx="1" fill="currentColor" opacity="0.3" />
      <rect x="8" y="21" width="10" height="2" rx="1" fill="currentColor" opacity="0.2" />
    </svg>
    {folderName && (
      <span
        // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
        className="max-w-full truncate text-[7px] text-foreground/20"
      >
        {folderName}
      </span>
    )}
  </div>
)

// ─── TabTracker: 任务流程卡 ───────────────────────────────────────────────────

const GOAL_STATUS_DOT: Record<string, string> = {
  active:    'bg-green-500',
  paused:    'bg-yellow-500',
  completed: 'bg-blue-500',
  draft:     'bg-muted-foreground/30',
  disabled:  'bg-muted-foreground/20',
}

const GOAL_TRIGGER_ICON: Record<string, string> = {
  cron:            '⏰',
  interval:        '🔄',
  manual:          '👆',
  webhook:         '🔗',
  table_event:     '📊',
  extension_event: '⚡',
  goal_completed:  '✅',
}

export const TabTrackerPreview: React.FC<{
  status?: string
  triggerType?: string
  stepCount?: number
  totalRuns?: number
  successRuns?: number
}> = ({ status, triggerType, stepCount = 0, totalRuns = 0, successRuns = 0 }) => {
  const { t } = useTranslation('tabtracker')
  const dotColor = (status && GOAL_STATUS_DOT[status]) || GOAL_STATUS_DOT.draft
  const triggerIcon = (triggerType && GOAL_TRIGGER_ICON[triggerType]) || '⚙️'
  const triggerLabel = triggerType ? t(`trigger.${triggerType}`, { defaultValue: triggerType }) : null
  const steps = Math.max(stepCount, 1)
  const visibleSteps = Math.min(steps, 5)

  return (
    <div className="flex h-full flex-col px-2.5 pt-2 pb-1.5">
      {/* 顶部：状态灯 + 触发类型 */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1">
          <div className={cn('h-[5px] w-[5px] rounded-full', dotColor)} />
          <span
            // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
            className="text-[7px] text-foreground/30 font-medium"
          >
            {status ? t(`status.${status}`, { defaultValue: status }) : ''}
          </span>
        </div>
        <span
          // eslint-disable-next-line tabtin/no-design-system-violations -- emoji 触发图标显示尺寸，非文字字号
          className="text-[8px] leading-none"
        >
          {triggerIcon}
        </span>
      </div>

      {/* 中部：步骤流程线 */}
      <div className="flex items-center gap-[2px] my-auto">
        {Array.from({ length: visibleSteps }).map((_, i) => (
          <React.Fragment key={i}>
            <div className={cn(
              'h-[6px] w-[6px] rounded-full border shrink-0',
              i === 0 ? 'border-green-400/50 bg-green-400/20' : 'border-foreground/[0.1] bg-foreground/[0.04]',
            )} />
            {i < visibleSteps - 1 && (
              <div className="h-[1px] flex-1 bg-foreground/[0.08]" />
            )}
          </React.Fragment>
        ))}
        {steps > 5 && (
          <>
            <div className="h-[1px] w-1 bg-foreground/[0.06]" />
            <span
              // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
              className="text-[6px] text-foreground/20"
            >
              +{steps - 5}
            </span>
          </>
        )}
      </div>

      {/* 底部：执行统计 + 触发标签 */}
      <div className="flex items-center justify-between mt-1.5">
        {totalRuns > 0 ? (
          <span
            // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
            className="text-[7px] text-foreground/20"
          >
            {successRuns}/{totalRuns}
          </span>
        ) : (
          <span
            // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
            className="text-[7px] text-foreground/15"
          >
            —
          </span>
        )}
        {triggerLabel && (
          <span
            // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
            className="rounded bg-foreground/[0.05] px-1 py-px text-[6px] text-foreground/25"
          >
            {triggerLabel}
          </span>
        )}
      </div>
    </div>
  )
}

// ─── Tins: 拼图/插件 ─────────────────────────────────────────────────────────

export const TinsPreview: React.FC<{
  iconUrl?: string
  isEnabled?: boolean
}> = ({ iconUrl, isEnabled }) => {
  const { t } = useTranslation('context')
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5">
      {iconUrl ? (
        <img src={iconUrl} alt="" className="h-8 w-8 rounded-md opacity-60" />
      ) : (
        <svg width="36" height="36" viewBox="0 0 36 36" className="text-foreground/[0.15]">
          <path d="M14 2 L14 8 L10 8 C8.5 8 7 9.5 7 11 L7 15 L2 15 L2 21 L7 21 L7 25 C7 26.5 8.5 28 10 28 L14 28 L14 34 L20 34 L20 28 L25 28 C26.5 28 28 26.5 28 25 L28 21 L34 21 L34 15 L28 15 L28 11 C28 9.5 26.5 8 25 8 L20 8 L20 2Z" fill="currentColor" opacity="0.4" />
        </svg>
      )}
      {isEnabled === false && (
        <span
          // eslint-disable-next-line tabtin/no-design-system-violations -- 卡片封面缩略图微型预览字号（非可读正文），语义字号会撑破 96px 封面
          className="text-[7px] text-foreground/20"
        >
          {t('preview.tinsDisabled')}
        </span>
      )}
    </div>
  )
}

// ─── Cover Builder 注册表 ────────────────────────────────────────────────────
//
// 扩展新类型时只需在此表中添加一个 builder 函数，无需修改 buildCoverContent 本身。

type CoverBuilder = (
  metadata: Record<string, unknown>,
  previewText?: string | null,
) => React.ReactNode | null

const coverBuilders: Record<string, CoverBuilder> = {
  tabdata: (m, previewText) => {
    const fieldNames = metaStrArr(m, 'field_names')
    if (!fieldNames?.length) return null
    const autoPreview = fieldNames.join(' | ')
    if (previewText && previewText !== autoPreview) return null
    return <TabDataPreview fieldNames={fieldNames} rowCount={metaNumOr(m, 'record_count', 0)} />
  },

  tabdoc: (m, previewText) => (
    <TabDocPreview text={previewText} icon={metaStr(m, 'icon')} version={metaNum(m, 'latest_version')} />
  ),

  tabslide: (m) => <TabSlidePreview pageCount={metaNumOr(m, 'page_count', 0)} />,

  tabcode: (m) => {
    let name: string | undefined
    const git = metaStr(m, 'gitRemoteUrl')
    if (git) name = git.replace(/\/$/, '').split('/').pop()?.replace(/\.git$/, '')
    if (!name) {
      const local = metaStr(m, 'localPath')
      if (local) name = local.replace(/\/$/, '').split('/').pop() || undefined
    }
    return <TabCodePreview projectName={name} />
  },

  tabsite: (m) => {
    const url = metaStr(m, 'published_url')
    const shortUrl = url ? url.replace(/^https?:\/\//, '') : undefined
    const fw = metaStr(m, 'framework')
    return <TabSitePreview url={shortUrl} framework={fw === 'react' ? 'React' : fw === 'vanilla' ? 'HTML/JS' : undefined} />
  },

  tabfolder: (m) => {
    const rawPath = metaStr(m, 'path')
    const folderName = rawPath ? rawPath.replace(/\/$/, '').split('/').pop() : undefined
    return <TabFolderPreview folderName={folderName} />
  },

  tabtracker: (m) => (
    <TabTrackerPreview
      status={metaStr(m, 'status')}
      triggerType={metaStr(m, 'trigger_type')}
      stepCount={metaNumOr(m, 'step_count', 0)}
      totalRuns={metaNumOr(m, 'total_runs', 0)}
      successRuns={metaNumOr(m, 'success_runs', 0)}
    />
  ),

  tins: (m) => (
    <TinsPreview iconUrl={metaStr(m, 'icon_url')} isEnabled={metaBool(m, 'is_enabled')} />
  ),

}

export function buildCoverContent(
  itemType: string,
  metadata?: Record<string, unknown> | null,
  previewText?: string | null,
): React.ReactNode | null {
  if (!metadata) return null
  const builder = coverBuilders[itemType]
  return builder ? builder(metadata, previewText) : null
}
