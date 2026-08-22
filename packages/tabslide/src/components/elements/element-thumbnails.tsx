import React, { useRef } from 'react'
import type { PPTElement } from '../../types/slides'
import { useMediaAutoplayGuard } from '../../hooks/useMediaAutoplayGuard'
import * as t from '../../theme'

type PPTVideoElement = Extract<PPTElement, { type: 'video' }>
type PPTAudioElement = Extract<PPTElement, { type: 'audio' }>
type PPTChartElement = Extract<PPTElement, { type: 'chart' }>
type PPTTableElement = Extract<PPTElement, { type: 'table' }>
type PPTCanvasElement = Extract<PPTElement, { type: 'canvas' }>

const mediaHintStyle: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 8,
  transform: 'translateX(-50%)',
  background: 'rgba(0, 0, 0, 0.72)',
  color: '#fff',
  fontSize: 11,
  lineHeight: '16px',
  padding: '4px 8px',
  borderRadius: 6,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  zIndex: 4,
}

const mediaHintBtnStyle: React.CSSProperties = {
  border: `1px solid rgba(255,255,255,0.35)`,
  background: 'rgba(255,255,255,0.12)',
  color: '#fff',
  fontSize: 11,
  lineHeight: '14px',
  borderRadius: 4,
  padding: '2px 8px',
  cursor: 'pointer',
}

export const CanvasEmbedContent: React.FC<{
  element: PPTCanvasElement
}> = ({ element }) => {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#fafafa',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {element.thumbnail ? (
        <img
          src={element.thumbnail}
          alt={element.canvasTitle || '画布'}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          draggable={false}
        />
      ) : (
        <>
          <div style={{ fontSize: 32, marginBottom: 8 }}>🔀</div>
          <div style={{ fontSize: 12, color: t.textTertiary }}>
            {element.canvasTitle || '嵌入画布'}
          </div>
        </>
      )}
    </div>
  )
}

export const VideoMediaThumbnail: React.FC<{
  element: PPTVideoElement
}> = ({ element }) => {
  return (
    <div style={{ width: '100%', height: '100%', background: t.bgMuted, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      {element.poster ? (
        <img
          src={element.poster}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          draggable={false}
        />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: t.textTertiary, fontSize: 18 }}>
          ▶
        </div>
      )}
      <div
        style={{
          position: 'absolute',
          right: 6,
          bottom: 6,
          fontSize: 10,
          padding: '1px 4px',
          borderRadius: 4,
          background: 'rgba(0, 0, 0, 0.6)',
          color: '#fff',
          lineHeight: '14px',
        }}
      >
        video
      </div>
    </div>
  )
}

export const VideoMediaContent: React.FC<{
  element: PPTVideoElement
}> = ({ element }) => {
  const mediaRef = useRef<HTMLVideoElement>(null)
  const {
    autoplayBlocked,
    autoplayMuted,
    onCanPlay,
    onPlaying,
    retryPlay,
  } = useMediaAutoplayGuard(mediaRef, {
    autoplay: element.autoplay,
    src: `${element.src}|${element.poster || ''}`,
    allowMutedRetry: true,
  })

  return (
    <div style={{ width: '100%', height: '100%', background: t.bgMuted, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
      <video
        ref={mediaRef}
        src={element.src}
        poster={element.poster}
        style={{ maxWidth: '100%', maxHeight: '100%' }}
        autoPlay={element.autoplay}
        loop={element.loop}
        controls
        playsInline
        preload="metadata"
        onCanPlay={onCanPlay}
        onPlaying={onPlaying}
      />
      {autoplayBlocked && (
        <div style={mediaHintStyle}>
          <span>自动播放受限</span>
          <button
            type="button"
            style={mediaHintBtnStyle}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              void retryPlay({ withSound: true })
            }}
          >
            点击播放
          </button>
        </div>
      )}
      {!autoplayBlocked && autoplayMuted && (
        <div style={mediaHintStyle}>
          <span>已静音自动播放</span>
          <button
            type="button"
            style={mediaHintBtnStyle}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              void retryPlay({ withSound: true })
            }}
          >
            开启声音
          </button>
        </div>
      )}
    </div>
  )
}

export const AudioMediaThumbnail: React.FC<{
  element: PPTAudioElement
}> = ({ element }) => {
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: t.bgMuted, borderRadius: t.radiusMd, position: 'relative' }}>
      <div style={{ textAlign: 'center', color: element.color || t.textSecondary }}>
        <div style={{ fontSize: 24, lineHeight: '24px' }}>♪</div>
      </div>
      <div
        style={{
          position: 'absolute',
          right: 6,
          bottom: 6,
          fontSize: 10,
          padding: '1px 4px',
          borderRadius: 4,
          background: 'rgba(0, 0, 0, 0.6)',
          color: '#fff',
          lineHeight: '14px',
        }}
      >
        audio
      </div>
    </div>
  )
}

export const AudioMediaContent: React.FC<{
  element: PPTAudioElement
}> = ({ element }) => {
  const mediaRef = useRef<HTMLAudioElement>(null)
  const {
    autoplayBlocked,
    onCanPlay,
    onPlaying,
    retryPlay,
  } = useMediaAutoplayGuard(mediaRef, {
    autoplay: element.autoplay,
    src: element.src,
    allowMutedRetry: false,
  })

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: t.bgMuted, borderRadius: t.radiusMd, position: 'relative' }}>
      <div style={{ textAlign: 'center', color: element.color || t.textSecondary }}>
        <div style={{ fontSize: 32 }}>♪</div>
        <audio
          ref={mediaRef}
          src={element.src}
          controls
          autoPlay={element.autoplay}
          loop={element.loop}
          preload="metadata"
          style={{ width: '80%', marginTop: 8 }}
          onCanPlay={onCanPlay}
          onPlaying={onPlaying}
        />
      </div>
      {autoplayBlocked && (
        <div style={mediaHintStyle}>
          <span>自动播放受限</span>
          <button
            type="button"
            style={mediaHintBtnStyle}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              void retryPlay({ withSound: true })
            }}
          >
            点击播放
          </button>
        </div>
      )}
    </div>
  )
}

export const ChartThumbnailContent: React.FC<{ element: PPTChartElement }> = ({ element }) => {
  const series = Array.isArray(element.data?.series) ? (element.data.series[0] || []) : []
  const points = series.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const maxValue = points.length > 0 ? Math.max(...points, 1) : 1
  const bars = points.slice(0, 6)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: element.fill || t.bgMuted,
        border: element.outline
          ? `${element.outline.width}px ${element.outline.style} ${element.outline.color}`
          : `1px solid ${t.borderLight}`,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'flex-end',
        gap: 2,
        padding: '6px 6px 4px',
        boxSizing: 'border-box',
      }}
    >
      {bars.length > 0
        ? bars.map((value, idx) => (
            <div
              key={`${idx}-${value}`}
              style={{
                flex: 1,
                minWidth: 2,
                height: `${Math.max(8, Math.round((value / maxValue) * 70))}%`,
                borderRadius: 2,
                background: (element.themeColors && element.themeColors[idx]) || t.accent,
              }}
            />
          ))
        : (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.textTertiary, fontSize: 11 }}>
              chart
            </div>
          )}
    </div>
  )
}

export const TableThumbnailContent: React.FC<{ element: PPTTableElement }> = ({ element }) => {
  const data = element.data ?? []
  const rows = data.length
  const cols = rows > 0 ? Math.max(...data.map((row) => row.length), 0) : 0
  const safeRows = Math.max(1, rows)
  const safeCols = Math.max(1, cols)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        border: element.outline
          ? `${element.outline.width}px ${element.outline.style} ${element.outline.color}`
          : `1px solid ${t.borderLight}`,
        borderRadius: 2,
        backgroundColor: '#fff',
        backgroundImage: [
          `linear-gradient(to right, ${t.borderLight} 1px, transparent 1px)`,
          `linear-gradient(to bottom, ${t.borderLight} 1px, transparent 1px)`,
        ].join(', '),
        backgroundSize: `${100 / safeCols}% 100%, 100% ${100 / safeRows}%`,
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          right: 4,
          bottom: 2,
          fontSize: 10,
          color: t.textTertiary,
          background: 'rgba(255,255,255,0.72)',
          borderRadius: 3,
          padding: '0 3px',
          lineHeight: '14px',
        }}
      >
        {safeRows}x{safeCols}
      </div>
    </div>
  )
}
