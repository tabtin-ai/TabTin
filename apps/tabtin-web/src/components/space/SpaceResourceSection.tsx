/**
 * SpaceResourceSection — Space 主页的通用资源区块
 *
 * 把「标题 + 计数 + 错误 + 空态 + 列表/宫格两种视图」收敛到一处，
 * 每种资源类型（文档 / 表格 / 后续其它）只需把数据映射成 SpaceResourceCard，
 * 不再为每个类型复制一份 list/grid 渲染。参考 Electron 侧 HomeGridCard /
 * ResourceListItem 的卡片抽象。
 */
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/utils/cn'

export type SpaceResourceViewMode = 'list' | 'grid'

/** 单个资源卡片的归一化数据 —— list / grid 共用 */
export interface SpaceResourceCard {
  id: string
  /** 资源标题（不含 emoji） */
  title: string
  /** emoji 图标，可空 */
  icon?: string | null
  /** 列表视图：标题下方的元信息行 */
  listMeta?: ReactNode
  /** 宫格视图：标题下方的元信息行 */
  gridMeta?: ReactNode
  /** 宫格封面图 URL（优先级最高） */
  coverImage?: string | null
  /** 宫格封面文本预览（次于封面图） */
  previewText?: string | null
  onClick: () => void
}

export interface SpaceResourceSectionProps {
  title: string
  /** 标题后的计数文案（如「3 篇文档」），加载中传 null 即隐藏 */
  countLabel?: ReactNode
  /** 区块图标，用于空态与宫格 fallback */
  icon: LucideIcon
  /** 宫格封面渐变（bg-gradient-to-br 之后的 class） */
  gridGradientClass: string
  /** 宫格 fallback 图标颜色 class */
  gridIconClass: string
  /** 宫格类型角标文案（如 TabDoc / TabData） */
  typeLabel: string
  /** 列表项右侧「打开」文案 */
  openLabel: string
  /** 空态文案 */
  emptyLabel: string
  /** 错误文案，非空则展示错误 */
  error?: string | null
  /** 加载中：用于隐藏计数与空态 */
  isLoading?: boolean
  viewMode: SpaceResourceViewMode
  cards: SpaceResourceCard[]
  className?: string
}

export function SpaceResourceSection({
  title,
  countLabel,
  icon: Icon,
  gridGradientClass,
  gridIconClass,
  typeLabel,
  openLabel,
  emptyLabel,
  error,
  isLoading = false,
  viewMode,
  cards,
  className,
}: SpaceResourceSectionProps) {
  return (
    <section className={cn('min-w-0 w-full', className)}>
      <h2 className="text-body font-medium text-muted-foreground mb-4">
        {title}
        {countLabel != null && countLabel !== '' && cards.length > 0 && (
          <span className="ml-2 text-body text-muted-foreground/60">{countLabel}</span>
        )}
      </h2>

      {error && (
        <div className="text-body text-destructive py-4 text-center">{error}</div>
      )}

      {!isLoading && !error && cards.length === 0 && (
        <div className="rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <Icon className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-body text-muted-foreground">{emptyLabel}</p>
        </div>
      )}

      {cards.length > 0 &&
        (viewMode === 'list' ? (
          <div className="space-y-2 min-w-0 w-full">
            {cards.map((card) => (
              <SpaceResourceListItem key={card.id} card={card} openLabel={openLabel} />
            ))}
          </div>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
          >
            {cards.map((card) => (
              <SpaceResourceGridCard
                key={card.id}
                card={card}
                icon={Icon}
                gradientClass={gridGradientClass}
                iconClass={gridIconClass}
                typeLabel={typeLabel}
              />
            ))}
          </div>
        ))}
    </section>
  )
}

function SpaceResourceListItem({
  card,
  openLabel,
}: {
  card: SpaceResourceCard
  openLabel: string
}) {
  return (
    <button
      type="button"
      onClick={card.onClick}
      className="flex w-full items-center justify-between rounded-xl border border-border bg-background px-4 py-3 text-left transition hover:border-primary/40 hover:bg-muted/30 min-w-0"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium text-foreground">
          {card.icon ? `${card.icon} ${card.title}` : card.title}
        </div>
        {card.listMeta && (
          <div className="mt-1 flex items-center gap-2 text-body text-muted-foreground">
            {card.listMeta}
          </div>
        )}
      </div>
      <div className="shrink-0 text-body text-primary ml-3">{openLabel}</div>
    </button>
  )
}

function SpaceResourceGridCard({
  card,
  icon: Icon,
  gradientClass,
  iconClass,
  typeLabel,
}: {
  card: SpaceResourceCard
  icon: LucideIcon
  gradientClass: string
  iconClass: string
  typeLabel: string
}) {
  const coverImage = card.coverImage?.trim() || null
  const previewText = card.previewText?.trim() || null
  const hasHeaderVisual = Boolean(coverImage || previewText)
  // 图标已在封面区展示时，标题不再重复前缀 emoji
  const gridTitle =
    card.icon && !hasHeaderVisual
      ? card.title
      : card.icon
        ? `${card.icon} ${card.title}`
        : card.title

  return (
    <button
      type="button"
      onClick={card.onClick}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-border/50 bg-background text-left transition-all hover:border-primary/40 hover:shadow-md active:scale-[0.98]"
    >
      <div className={cn('relative h-[88px] overflow-hidden bg-gradient-to-br', gradientClass)}>
        {coverImage ? (
          <>
            <img
              src={coverImage}
              alt=""
              className="absolute inset-0 h-full w-full object-cover opacity-80"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background/90 via-background/40 to-transparent" />
          </>
        ) : previewText ? (
          <>
            <div className="absolute inset-0 px-3 pt-2.5 pb-1 overflow-hidden">
              <p className="text-caption leading-relaxed text-foreground/65 dark:text-foreground/55 line-clamp-4 whitespace-pre-wrap break-words font-[350]">
                {previewText.slice(0, 200)}
              </p>
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-background/90 via-background/40 to-transparent" />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1">
            {card.icon ? (
              <span className="text-[32px] leading-none opacity-60 drop-shadow-sm transition-transform duration-300 group-hover:scale-110 group-hover:opacity-80">
                {card.icon}
              </span>
            ) : (
              <Icon className={cn('h-8 w-8 transition-transform duration-300 group-hover:scale-110', iconClass)} />
            )}
            <span className="text-caption font-medium tracking-wide text-foreground/30 dark:text-foreground/25 uppercase">
              {typeLabel}
            </span>
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-2.5 py-2 min-h-[44px]">
        <span className="truncate text-body font-medium text-foreground leading-tight">
          {gridTitle}
        </span>
        {card.gridMeta && (
          <div className="flex items-center gap-1.5 text-caption text-muted-foreground/60 leading-tight">
            {card.gridMeta}
          </div>
        )}
      </div>
    </button>
  )
}
