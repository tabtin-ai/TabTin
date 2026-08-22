/**
 * VideoTimelineCard — 视频时间线卡片，渲染 tabvideo.get_timeline 输出。
 *
 * 展示场景列表、每个场景中的轨道（视频/音频/字幕）及元素数量摘要。
 * 自注册为 'VideoTimelineCard'。
 */

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Film, Music, Type, ChevronDown, ChevronRight, Clock } from 'lucide-react'
import { cn } from '@utils/cn'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { CardRendererProps } from '../registry/types'
import {
  CARD_RADIUS,
  CARD_HEADER_PADDING,
  CARD_PADDING,
  TEXT,
  BORDER,
  BG,
  TEXT_COLOR,
  CARD_MAX_HEIGHT,
  ICON_SIZE,
} from '../registry/chatDesignTokens'
import { registerCardRenderer } from '../registry/cardRenderers'
import { ErrorBanner, LoadingPlaceholder } from './primitives'

/* ─── 数据类型 ──────────────────────────────────────────────────────── */

interface TimelineElement {
  id: string
  type: string
  name: string
  startTime: number
  duration: number
}

interface TimelineTrack {
  id: string
  name: string
  type: string
  elementCount: number
  elements: TimelineElement[]
}

interface TimelineScene {
  id: string
  name: string
  isMain: boolean
  trackCount: number
  tracks: TimelineTrack[]
}

interface TimelineData {
  project_id: string
  total_duration_sec: number
  scene_count: number
  total_elements: number
  resolution: string
  fps: number
  scenes: TimelineScene[]
  status?: string
  message?: string
}

/* ─── 辅助函数 ──────────────────────────────────────────────────────── */

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function TrackIcon({ type }: { type: string }) {
  const cls = cn(ICON_SIZE.md, TEXT_COLOR.muted, 'shrink-0')
  if (type === 'video') return <Film className={cls} />
  if (type === 'audio') return <Music className={cls} />
  return <Type className={cls} />
}

/* ─── 子组件：单个场景行 ─────────────────────────────────────────────── */

const SceneRow: React.FC<{ scene: TimelineScene; index: number }> = React.memo(
  ({ scene, index }) => {
    const [expanded, setExpanded] = useState(index === 0)

    return (
      <div className={cn('border-b last:border-0', BORDER.subtle)}>
        {/* 场景标题行 */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'flex w-full min-w-0 items-center gap-1.5',
            CARD_PADDING.x,
            'py-1.5',
            'hover:bg-muted/10 transition-colors text-left',
          )}
        >
          {expanded ? (
            <ChevronDown className={cn(ICON_SIZE.sm, TEXT_COLOR.faint, 'shrink-0')} />
          ) : (
            <ChevronRight className={cn(ICON_SIZE.sm, TEXT_COLOR.faint, 'shrink-0')} />
          )}

          <span className={cn(TEXT.label, TEXT_COLOR.secondary, 'min-w-0 flex-1 truncate')}>
            {scene.name || `Scene ${index + 1}`}
          </span>

          {scene.isMain && (
            <span
              className={cn(
                // 极小 badge 用 caption + medium + tracking 表达密度，不写死 text-[10px]
                'shrink-0 px-1 rounded',
                'text-caption font-medium tracking-wider',
                'bg-accent/10 text-accent/80',
              )}
            >
              主
            </span>
          )}

          <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'shrink-0')}>
            {scene.trackCount} tracks · {scene.tracks.reduce((s, t) => s + t.elementCount, 0)} elements
          </span>
        </button>

        {/* 展开轨道列表 */}
        {expanded && scene.tracks.length > 0 && (
          <div className={cn('pb-1', BG.card)}>
            {scene.tracks.map((track) => (
              <div
                key={track.id}
                className={cn(
                  'flex min-w-0 items-center gap-2',
                  'pl-7 pr-3 py-0.5',
                )}
              >
                <TrackIcon type={track.type} />

                <span className={cn(TEXT.meta, TEXT_COLOR.secondary, 'min-w-0 flex-1 truncate')}>
                  {track.name || track.type}
                </span>

                <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'shrink-0')}>
                    {track.elementCount}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  },
)
SceneRow.displayName = 'SceneRow'

/* ─── 主展示组件 ─────────────────────────────────────────────────────── */

interface VideoTimelineCardProps {
  data: TimelineData
}

const VideoTimelineCard: React.FC<VideoTimelineCardProps> = React.memo(({ data }) => {
  const { t } = useTranslation('chat')
  const { total_duration_sec, scene_count, total_elements, resolution, fps, scenes } = data

  return (
    <div className={'overflow-hidden'}>
      {/* 头部 */}
      <div
        className={cn(
          'flex items-center gap-2',
          CARD_HEADER_PADDING.x,
          CARD_HEADER_PADDING.y,
          BG.header,
          'border-b',
          BORDER.subtle,
        )}
      >
        <Film className={cn(ICON_SIZE.md, TEXT_COLOR.muted)} />
        <span className={cn(TEXT.header, TEXT_COLOR.secondary)}>{t('card.video_get_timeline')}</span>

        <div className={cn('ml-auto flex items-center gap-3 shrink-0')}>
          <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>{resolution}</span>
          <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>{fps}fps</span>
          <span
            className={cn(
              'flex items-center gap-1',
              TEXT.meta,
              TEXT_COLOR.muted,
            )}
          >
            <Clock className={cn(ICON_SIZE.sm)} />
            {formatDuration(total_duration_sec)}
          </span>
        </div>
      </div>

      {/* 摘要栏 */}
      <div
        className={cn(
          'flex items-center gap-3',
          CARD_HEADER_PADDING.x,
          'py-1',
          'border-b',
          BORDER.subtle,
          BG.header,
        )}
      >
        <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>
          {scene_count} scenes
        </span>
        <span className={cn(TEXT.meta, TEXT_COLOR.faint, 'opacity-40')}>·</span>
        <span className={cn(TEXT.meta, TEXT_COLOR.faint)}>
          {total_elements} elements
        </span>
      </div>

      {/* 场景列表 */}
      {scenes.length > 0 ? (
        <ScrollArea className={CARD_MAX_HEIGHT.md}>
          {scenes.map((scene, i) => (
            <SceneRow key={scene.id || i} scene={scene} index={i} />
          ))}
        </ScrollArea>
      ) : (
        <div
          className={cn(
            CARD_HEADER_PADDING.x,
            CARD_HEADER_PADDING.y,
            TEXT.meta,
            TEXT_COLOR.faint,
          )}
        >
          {t('card.video_no_scenes', { defaultValue: 'No scenes' })}
        </div>
      )}
    </div>
  )
})

VideoTimelineCard.displayName = 'VideoTimelineCard'

/* ─── 渲染器适配器 ───────────────────────────────────────────────────── */

const VideoTimelineCardRenderer: React.FC<CardRendererProps> = React.memo((props) => {
  const { error, phase } = props

  if (error) return <ErrorBanner error={error} />

  const raw = (props.data ?? props.output) as TimelineData | null | undefined

  if (!raw || typeof raw !== 'object') {
    if (phase === 'start' || phase === 'running') return <LoadingPlaceholder />
    return null
  }

  if (raw.status === 'empty') {
    return (
      <div
        className={cn(
          CARD_RADIUS,
          'border',
          BORDER.default,
          BG.card,
          CARD_HEADER_PADDING.x,
          CARD_HEADER_PADDING.y,
          TEXT.meta,
          TEXT_COLOR.faint,
        )}
      >
        {raw.message ?? 'Empty timeline'}
      </div>
    )
  }

  if (!Array.isArray(raw.scenes)) return null

  return <VideoTimelineCard data={raw} />
})

VideoTimelineCardRenderer.displayName = 'VideoTimelineCardRenderer'

/* ─── 自注册 ────────────────────────────────────────────────────────── */

registerCardRenderer('VideoTimelineCard', VideoTimelineCardRenderer)

export { VideoTimelineCard, VideoTimelineCardRenderer }
export default VideoTimelineCard
