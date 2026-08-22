/**
 * 导入流程价值示意：只读安全 + 搬入 TabTin 后的核心收益。
 */
import React from 'react'
import {
  ArrowRight,
  Bot,
  Cloud,
  DownloadCloud,
  Layers,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'
import type { ImportSourceId } from '@tabtin/cli-server-core'
import { cn } from '@utils/cn'
import { IMPORT_SOURCE_ICON_URLS } from './importSourceIcons'

const DIAGRAM_SOURCES: ImportSourceId[] = ['claude_code', 'codex', 'cursor', 'workbuddy']

const IMPORT_BENEFITS: Array<{ icon: LucideIcon; label: string }> = [
  { icon: Bot, label: '任意模型 · Agent 接着聊' },
  { icon: Cloud, label: '手机电脑多端同步' },
  { icon: Layers, label: '表格、自动化等 TabTin 能力' },
]

export const ImportReadOnlyDiagram: React.FC<{ className?: string }> = ({ className }) => (
  <section
    className={cn(
      'mb-4 shrink-0 overflow-hidden rounded-xl border border-border/40 bg-muted/10',
      className,
    )}
    data-testid="import-readonly-diagram"
    aria-label="导入说明与 TabTin 优势"
  >
    <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-stretch">
      {/* 只读复制示意 */}
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-4 lg:px-5">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 sm:gap-x-4">
          <div className="flex flex-col items-center gap-1">
            <div className="flex items-center -space-x-1.5" aria-hidden>
              {DIAGRAM_SOURCES.map((source) => {
                const src = IMPORT_SOURCE_ICON_URLS[source]
                return (
                  <div
                    key={source}
                    className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background shadow-sm sm:h-8 sm:w-8"
                  >
                    {src ? (
                      <img src={src} alt="" className="h-5 w-5 object-contain sm:h-6 sm:w-6" draggable={false} />
                    ) : null}
                  </div>
                )
              })}
            </div>
            <span className="text-[11px] text-muted-foreground/75">本机其他平台</span>
          </div>

          <div className="flex flex-col items-center gap-0.5 text-muted-foreground/65" aria-hidden>
            <ArrowRight className="h-4 w-4 sm:h-5 sm:w-5" strokeWidth={1.75} />
            <span className="text-[10px] font-medium tracking-wide sm:text-[11px]">只读复制</span>
          </div>

          <div className="flex flex-col items-center gap-1">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 sm:h-9 sm:w-9"
              aria-hidden
            >
              <DownloadCloud className="h-4 w-4 text-accent sm:h-[18px] sm:w-[18px]" strokeWidth={1.75} />
            </div>
            <span className="text-[11px] font-medium text-foreground/90">TabTin</span>
          </div>
        </div>

        <p className="flex max-w-sm items-center justify-center gap-1 text-center text-[11px] leading-snug text-muted-foreground/80 sm:text-caption">
          <ShieldCheck className="h-3 w-3 shrink-0 text-success" aria-hidden />
          <span>
            仅读取并复制，
            <span className="text-foreground/85">不会改动</span>
            原平台数据
          </span>
        </p>
      </div>

      <div
        className="hidden w-px self-stretch bg-border/35 lg:block"
        aria-hidden
      />

      <div className="border-t border-border/35 px-4 py-3.5 lg:border-t-0 lg:px-5 lg:py-4">
        <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 lg:gap-2.5">
          {IMPORT_BENEFITS.map(({ icon: Icon, label }) => (
            <li
              key={label}
              className="flex items-center gap-2 rounded-lg bg-background/40 px-2.5 py-2 lg:bg-transparent lg:px-0 lg:py-0"
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/8 text-accent"
                aria-hidden
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
              </span>
              <span className="text-caption leading-snug text-foreground/85">{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  </section>
)
