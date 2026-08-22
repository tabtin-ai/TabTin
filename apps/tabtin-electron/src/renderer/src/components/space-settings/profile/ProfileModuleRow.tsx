/**
 * ProfileModuleRow — Agent 档案的"模块行"
 *
 * 设计取向：简历"经历"项排版 — 标题在上 / 内容在下（始终 stack）
 * - 不用 viewport-based breakpoint：pane 嵌在 right sheet 里大概率窄，
 *   横排 key-value 在窄容器下会把 preview 列挤到一字一行
 * - label 与 chevron 一行（chevron 仅 hover 显），preview 独占一行
 * - 行之间靠父级 divide-y 划开；行本身无背景、无圆角，hover 才有极轻底色
 *
 * 视觉形态（任何宽度）：
 *   自定义规则                                                    ›
 *   告诉 Tin 在所有对话中遵循的规则…
 *   ─────────────────────────────────────────────────────────────
 *   技能  12                                                       ›
 *   Browser · TabData · TabDoc · …
 */
import React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'

export interface ProfileModuleRowProps {
  label: string
  /** label 旁的轻量徽章（数字或简短文字），极淡、tabular */
  count?: number | string | null
  /** 标题下方的 preview 节点 */
  preview?: React.ReactNode
  /** preview 为空时在标题下方显示的状态文字 */
  status?: string | null
  disabled?: boolean
  onClick: () => void
}

export const ProfileModuleRow: React.FC<ProfileModuleRowProps> = ({
  label,
  count,
  preview,
  status,
  disabled,
  onClick,
}) => {
  const hasPreview = preview !== null && preview !== undefined
  const hasCount = count !== null && count !== undefined && count !== ''
  const hasBody = hasPreview || !!status

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group block w-full text-left transition-colors rounded-md',
        // 左右各 8px 外扩做 hover bg；右侧 24px 内 padding 让 label/preview 都避开 chevron 视觉区
        '-mx-2 pl-2 pr-6 py-3.5',
        'hover:bg-muted/[0.05] focus-visible:bg-muted/[0.08] focus-visible:outline-none',
        disabled && 'opacity-60 cursor-not-allowed',
      )}
    >
      {/* 标题行：label + count；chevron 用 -mr-4 突破 pr-6 浮在 row 右侧 */}
      <div className="flex items-baseline gap-2">
        <div className="flex items-baseline gap-2 min-w-0 flex-1">
          <span className="text-body font-medium text-foreground truncate">
            {label}
          </span>
          {hasCount && (
            <span className="shrink-0 text-caption tabular-nums text-muted-foreground/60">
              {count}
            </span>
          )}
        </div>
        <ChevronRight
          className={cn(
            '-mr-4 shrink-0 self-center h-3.5 w-3.5 transition-opacity',
            'text-muted-foreground/60',
            'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        />
      </div>

      {/* preview 行：受 button pr-6 约束，末端不会贴 row 右边缘 */}
      {hasBody && (
        <div className="mt-1.5 min-w-0">
          {hasPreview ? (
            preview
          ) : (
            <p className="text-body text-muted-foreground/80">{status}</p>
          )}
        </div>
      )}
    </button>
  )
}

// ---------------------------------------------------------------------------
// PreviewHint — 未配置时的引导文案（更淡）
// ---------------------------------------------------------------------------

export const ModulePreviewHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-body text-muted-foreground/60 leading-relaxed line-clamp-2">{children}</p>
)

// ---------------------------------------------------------------------------
// ItemList — 用 · 分隔的 inline 文本列表（保留：Skills / Apps / Extensions 仍用它）
// ---------------------------------------------------------------------------

export const ItemList: React.FC<{
  items: string[]
  remaining?: number
}> = ({ items, remaining = 0 }) => {
  return (
    <p className="text-body text-foreground/80 leading-relaxed line-clamp-2">
      {items.map((it, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 && <span className="text-muted-foreground/40 mx-1.5">·</span>}
          <span>{it}</span>
        </React.Fragment>
      ))}
      {remaining > 0 && (
        <>
          <span className="text-muted-foreground/40 mx-1.5">·</span>
          <span className="text-muted-foreground/60">{`还有 ${remaining}`}</span>
        </>
      )}
    </p>
  )
}

// ---------------------------------------------------------------------------
// SectionTitle — 简历风格的左对齐章节小标题
// ---------------------------------------------------------------------------

export const SectionTitle: React.FC<{
  children: React.ReactNode
  className?: string
}> = ({ children, className }) => (
  <h3
    className={cn(
      'text-caption font-medium uppercase tracking-[0.18em]',
      'text-muted-foreground/80 mb-2',
      className,
    )}
  >
    {children}
  </h3>
)

// ---------------------------------------------------------------------------
// 兼容旧 import: ModuleGroupLabel 别名
// ---------------------------------------------------------------------------

export const ModuleGroupLabel = SectionTitle
