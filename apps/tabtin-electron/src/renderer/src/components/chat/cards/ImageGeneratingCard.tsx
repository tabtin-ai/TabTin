/**
 * ImageGeneratingCard — 对话生图等待态。
 *
 * 「图位」画布 + 单条状态文案 + 细进度条（无百分比）。
 * 假进度由前端 ease-out 驱动；进度条用 scaleX，rAF 直接写 DOM（避免每帧 React 重渲染卡顿）。
 *
 * ## 动效只有一处，它在画布上
 *
 *  L2 定的是「整张卡只留一处持续动效」，当时那一处放在文案的 ShinyText 扫光上，画布是静止的。
 * 现在把它挪到画布：跑 {@link AgentOrb} 的 `shaping` 纹理，圆 → 三角 → 方 轮播。规则没破——文案改回
 * 普通文本，扫光撤掉，全卡仍然只有一处在动。挪的理由是这处动效终于有话可说：
 * 静态图标只是「这里将来是张图」，形态轮播说的是「图正在成形」，跟进度条讲的是同一件事。
 *
 * 失败 / 成功不挂 orb——那不是「正在进行」，静态图标即可。
 */

import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ImageIcon } from 'lucide-react'
import { cn } from '@utils/cn'
import { ICON_SIZE, IMAGE_PREVIEW, TEXT_COLOR } from '../registry/chatDesignTokens'
import { AgentOrb } from '../orb/AgentOrb'
import { computeImageGeneratingProgress } from './imageGeneratingProgress'

/**
 * 画布中央 orb 的边长。
 *
 * 图位框是 5:4、最宽 400——144 约占框宽 36%：小到 96 会像个 spinner，大到 192 就压过图位本身。
 * 窄列时框会等比缩，但聊天列很少窄到 200 以下，届时 144 仍留得下上下留白。
 */
const ORB_SIZE_PX = 144

/**
 * 走时倍率，1 = 预设原速（2.405），每个形态停约 0.58 秒、一轮 1.7 秒。
 *
 * 曾按「大画面该放慢」的推断压到 0.4（每形 1.5 秒），实机上偏慢、像卡住；原速才读作「在动」。
 */
const ORB_SPEED_SCALE = 1

export type ImageGeneratingPhase = 'running' | 'success' | 'failed'

export type ImageGeneratingCardProps = {
  phase: ImageGeneratingPhase
  /** Date.now 毫秒；缺省用 mount 时间 */
  startedAtMs?: number
  /** 可选：从 --prompt 截断展示 */
  promptPreview?: string
}

function progressToScale(progress: number): number {
  return Math.max(0, Math.min(1, progress / 100))
}

const ImageGeneratingCard: React.FC<ImageGeneratingCardProps> = React.memo(
  ({ phase, startedAtMs, promptPreview }) => {
    const { t } = useTranslation('chat')
    const mountAtRef = useRef(Date.now())
    // ：冻结最早锚点。流式挂卡时 startedAtMs 常为 undefined（用 mount 时间），
    // 稍后 tool_started 才带上更晚的 Date.now()——若直接采纳会把进度归零再播。
    // 只允许更早的 startedAtMs 回写（更接近真实开始），绝不前移。
    const anchorRef = useRef(startedAtMs ?? mountAtRef.current)
    if (startedAtMs != null && startedAtMs < anchorRef.current) {
      anchorRef.current = startedAtMs
    }
    const anchorMs = anchorRef.current
    const done = phase !== 'running'
    const barRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      const el = barRef.current
      if (!el) return undefined

      if (done) {
        // 终态一次性 ease 到满格；运行中不加 CSS transition，避免与 rAF 打架发涩
        el.style.transition = 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)'
        el.style.transform = 'scaleX(1)'
        return undefined
      }

      el.style.transition = 'none'
      let rafId = 0
      const tick = () => {
        const progress = computeImageGeneratingProgress({
          elapsedMs: Math.max(0, Date.now() - anchorMs),
          done: false,
        })
        el.style.transform = `scaleX(${progressToScale(progress)})`
        rafId = window.requestAnimationFrame(tick)
      }
      // 首帧立刻落点，避免空一拍
      el.style.transform = `scaleX(${progressToScale(
        computeImageGeneratingProgress({
          elapsedMs: Math.max(0, Date.now() - anchorMs),
          done: false,
        }),
      )})`
      rafId = window.requestAnimationFrame(tick)
      return () => window.cancelAnimationFrame(rafId)
    }, [anchorMs, done])

    const caption =
      phase === 'failed'
        ? t('richContent.imageGenerateFailed', { defaultValue: '生成失败' })
        : t('richContent.imageGenerating', { defaultValue: '正在生成图片' })

    const initialScale = progressToScale(
      computeImageGeneratingProgress({
        elapsedMs: Math.max(0, Date.now() - anchorMs),
        done,
      }),
    )

    return (
      <div
        data-testid="image-generating-card"
        data-phase={phase}
        className={cn(
          'flex flex-col gap-2 py-1',
          IMAGE_PREVIEW.maxWClass,
        )}
      >
        <div
          data-testid="image-generating-canvas"
          className={cn(
            // 与 RichImage 同款边框图位；底色高于对话面，避免「融进背景」
            'relative w-full overflow-hidden rounded-lg',
            'border border-border/40',
            'bg-muted/55 dark:bg-muted/35',
            phase === 'failed' && 'border-destructive/30 bg-destructive/5',
          )}
          style={{
            // 与 IMAGE_PREVIEW 框对齐的稳定占位，避免进度跳动撑开虚拟行
            aspectRatio: `${IMAGE_PREVIEW.maxW} / ${IMAGE_PREVIEW.maxH}`,
            maxHeight: IMAGE_PREVIEW.maxH,
          }}
        >
          {/* 中心：进行中跑形态轮播，其余状态静态图标示意「这里将是一张图」 */}
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center',
              phase === 'failed' ? 'text-destructive/50' : TEXT_COLOR.faint,
            )}
            aria-hidden
          >
            {phase === 'running' ? (
              <AgentOrb
                texture="shaping"
                cssSize={ORB_SIZE_PX}
                speedScale={ORB_SPEED_SCALE}
                decorative
              />
            ) : (
              <ImageIcon className="h-8 w-8 opacity-70" strokeWidth={1.25} />
            )}
          </div>

          <div
            className="absolute inset-x-0 bottom-0 h-1 bg-foreground/10"
            aria-hidden
          >
            <div
              ref={barRef}
              data-testid="image-generating-progress-bar"
              className={cn(
                'h-full w-full origin-left will-change-transform',
                phase === 'failed' ? 'bg-destructive/60' : 'bg-foreground/45',
              )}
              style={{
                transform: `scaleX(${done ? 1 : initialScale})`,
              }}
            />
          </div>
        </div>

        {/* 文案一律静态：这张卡唯一的持续动效已经交给画布上的 orb */}
        <div className="flex items-center gap-1.5 min-w-0">
          {phase === 'failed' ? (
            <AlertCircle
              className={cn(ICON_SIZE.md, 'shrink-0 text-destructive/70')}
              strokeWidth={1.75}
              aria-hidden
            />
          ) : (
            <ImageIcon
              className={cn(ICON_SIZE.md, 'shrink-0', TEXT_COLOR.faint)}
              strokeWidth={1.75}
              aria-hidden
            />
          )}
          <p className="text-caption text-muted-foreground/80 truncate min-w-0">
            {caption}
          </p>
        </div>
        {promptPreview ? (
          <p
            data-testid="image-generating-prompt"
            className="text-caption text-muted-foreground/60 truncate"
            title={promptPreview}
          >
            {promptPreview}
          </p>
        ) : null}
      </div>
    )
  },
)

ImageGeneratingCard.displayName = 'ImageGeneratingCard'

export { ImageGeneratingCard }
export default ImageGeneratingCard
