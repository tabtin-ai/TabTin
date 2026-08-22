import React, { useRef } from 'react'
import type { PPTElement } from '../../types/slides'
import { sanitizeHtml } from '../../utils/sanitize'
import {
  getTableThemeColors,
  getCellThemeStyle,
  resolveTableCellStyle,
  getTableColumnCount,
  normalizeTableColWidths,
  normalizeTableRowHeights,
  resolveTableOuterBorderSpecs,
  resolveTableCellBorderSpecs,
  tableBorderSpecToCss,
} from '../../utils/tableTheme'
import { normalizeLatexSvgForDisplay } from '../../utils/latex-shared'
import { buildShadowStyle, buildDropShadowFilter, ptToPx } from '../../utils/geometry'
import { getLinePathD } from '../../utils/line-geometry'
import { getShapePath } from '../../configs/shapes'
import { useMediaAutoplayGuard } from '../../hooks/useMediaAutoplayGuard'
import ChartElement from '../elements/ChartElement'
import * as t from '../../theme'
import { useT } from '../../i18n'
import { STAGE_BG, MEDIA_HINT_BG, MEDIA_HINT_FG } from './constants'

// ── 元素内容渲染（放映模式专用，不可交互） ──

export const SlideShowElementContent: React.FC<{ element: PPTElement }> = ({ element }) => {
  const translate = useT()
  switch (element.type) {
    case 'text': {
      const tm = element.margin
      return (
        <div
          style={{
            width: '100%',
            height: '100%',
            fontFamily: element.defaultFontName || 'inherit',
            fontSize: element.defaultFontSize ? `${element.defaultFontSize}pt` : undefined,
            color: element.defaultColor,
            lineHeight: element.lineHeight ? `${element.lineHeight}` : undefined,
            letterSpacing: element.wordSpace ? `${element.wordSpace}px` : undefined,
            background: element.fill || 'transparent',
            writingMode: element.vertical ? 'vertical-rl' : undefined,
            overflow: 'hidden',
            boxSizing: 'border-box' as const,
            paddingTop: tm?.top ? `${tm.top}px` : undefined,
            paddingRight: tm?.right ? `${tm.right}px` : undefined,
            paddingBottom: tm?.bottom ? `${tm.bottom}px` : undefined,
            paddingLeft: tm?.left ? `${tm.left}px` : undefined,
          }}
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(element.content) }}
        />
      )
    }

    case 'image': {
      const imgFilters = element.filters
        ? [
            element.filters.brightness !== undefined && `brightness(${element.filters.brightness})`,
            element.filters.contrast !== undefined && `contrast(${element.filters.contrast})`,
            element.filters.saturate !== undefined && `saturate(${element.filters.saturate})`,
            element.filters.blur !== undefined && `blur(${element.filters.blur}px)`,
            element.filters.grayscale !== undefined && `grayscale(${element.filters.grayscale})`,
            element.filters.invert !== undefined && `invert(${element.filters.invert})`,
            element.filters.hueRotate !== undefined && `hue-rotate(${element.filters.hueRotate}deg)`,
            element.filters.sepia !== undefined && `sepia(${element.filters.sepia})`,
          ].filter(Boolean).join(' ')
        : undefined

      const imgClipPath = (() => {
        if (!element.clip) return undefined
        if (element.clip.shape === 'ellipse') return 'ellipse(50% 50% at 50% 50%)'
        if (element.clip.range && element.clip.range.length >= 4) {
          return `polygon(${element.clip.range.map((p: number[]) => `${p[0] * 100}% ${p[1] * 100}%`).join(', ')})`
        }
        return undefined
      })()

      return (
        <div style={{
          width: '100%', height: '100%', position: 'relative', overflow: 'hidden',
          borderRadius: element.radius ? `${element.radius}px` : undefined,
          border: element.outline
            ? `${element.outline.width}px ${element.outline.style} ${element.outline.color}`
            : undefined,
          boxShadow: element.shadow
            ? buildShadowStyle(element.shadow)
            : undefined,
        }}>
          {element.src ? (
            <img
              src={element.src}
              alt=""
              onError={(e) => {
                const target = e.currentTarget
                target.style.display = 'none'
                if (target.parentElement) {
                  const placeholder = document.createElement('div')
                  placeholder.style.cssText = 'width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#f5f5f5;color:;font-size:12px;'
                  placeholder.textContent = translate('image.loadFailed')
                  target.parentElement.appendChild(placeholder)
                }
              }}
              style={{
                width: '100%',
                height: '100%',
                objectFit: element.objectFit || 'cover',
                borderRadius: element.radius ? `${element.radius}px` : undefined,
                filter: imgFilters,
                clipPath: imgClipPath,
              }}
              draggable={false}
            />
          ) : (
            <div style={{
              width: '100%', height: '100%', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              background: '#f5f5f5', color: '#999', fontSize: 12,
            }}>
              {translate('image.loadFailed')}
            </div>
          )}
          {element.colorMask && (
            <div style={{
              position: 'absolute', inset: 0, background: element.colorMask,
              borderRadius: element.radius ? `${element.radius}px` : undefined,
              clipPath: imgClipPath,
              pointerEvents: 'none',
            }} />
          )}
        </div>
      )
    }

    case 'shape': {
      const shapeGradId = `ss-grad-${element.id}`
      const shapePatId = `ss-pat-${element.id}`
      const shapeClipId = `ss-clip-${element.id}`
      const actualPath = getShapePath(
        element.pathFormula,
        element.path,
        element.width,
        element.height,
        element.keypoints,
      )
      const viewBox = element.pathFormula
        ? `0 0 ${element.width} ${element.height}`
        : `0 0 ${element.viewBox?.[0] ?? element.width} ${element.viewBox?.[1] ?? element.height}`
      const shapeFill = element.gradient
        ? `url(#${shapeGradId})`
        : element.pattern
          ? `url(#${shapePatId})`
        : element.fill === 'transparent' || element.fill === 'none'
          ? 'transparent'
          : element.fill || t.accent
      const shapeOutline = element.outline
        ? {
            stroke: element.outline.color,
            strokeWidth: element.outline.width,
            strokeDasharray:
              element.outline.style === 'dashed' ? '8 4'
                : element.outline.style === 'dotted' ? '2 2'
                : element.outline.style === 'dashDot' ? '8 4 2 4'
                : element.outline.style === 'longDash' ? '16 4'
                : element.outline.style === 'longDashDot' ? '16 4 2 4'
                : undefined,
          }
        : {}
      const shapeShadow = element.shadow
        ? buildDropShadowFilter(element.shadow)
        : undefined

      return (
        <svg
          width="100%"
          height="100%"
          viewBox={viewBox}
          preserveAspectRatio="none"
          style={{ filter: shapeShadow, overflow: 'visible' }}
        >
          {(element.gradient || element.pattern || element.text) && (
            <defs>
              <clipPath id={shapeClipId}>
                <path d={actualPath} />
              </clipPath>
              {element.gradient && (element.gradient.type === 'linear' ? (
                <linearGradient id={shapeGradId} gradientTransform={`rotate(${element.gradient.rotate}, 0.5, 0.5)`}>
                  {element.gradient.colors.map((s, i) => (
                    <stop key={i} offset={`${s.pos * 100}%`} stopColor={s.color} />
                  ))}
                </linearGradient>
              ) : (
                <radialGradient
                  id={shapeGradId}
                  cx={element.gradient.center?.x ?? 0.5}
                  cy={element.gradient.center?.y ?? 0.5}
                  r={0.5}
                  fx={element.gradient.center?.x ?? 0.5}
                  fy={element.gradient.center?.y ?? 0.5}
                  gradientUnits="objectBoundingBox"
                >
                  {element.gradient.colors.map((s, i) => (
                    <stop key={i} offset={`${s.pos * 100}%`} stopColor={s.color} />
                  ))}
                </radialGradient>
              ))}
              {element.pattern && (
                <pattern
                  id={shapePatId}
                  patternUnits="objectBoundingBox"
                  patternContentUnits="objectBoundingBox"
                  width="1"
                  height="1"
                >
                  <image href={element.pattern} width="1" height="1" preserveAspectRatio="xMidYMid slice" />
                </pattern>
              )}
            </defs>
          )}
          <path d={actualPath} fill={shapeFill} {...shapeOutline} />
          {element.text && (
            <foreignObject x="0" y="0" width="100%" height="100%" clipPath={`url(#${shapeClipId})`}>
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: element.text.align === 'right' ? 'flex-end' : element.text.align === 'center' ? 'center' : 'flex-start',
                  justifyContent: element.text.verticalAlign === 'bottom' ? 'flex-end' : element.text.verticalAlign === 'middle' ? 'center' : 'flex-start',
                  color: element.text.defaultColor || t.textPrimary,
                  fontSize: element.text.defaultFontSize || 14,
                  fontFamily: element.text.defaultFontName || 'inherit',
                  textAlign: element.text.align || 'center',
                  padding: 8,
                  overflow: 'hidden',
                  wordBreak: 'break-word',
                }}
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(element.text.content) }}
              />
            </foreignObject>
          )}
        </svg>
      )
    }

    case 'line': {
      const lineColor = element.color || t.textPrimary
      const lineW = ptToPx(element.lineWidth || 2)
      const lineDash = element.style === 'dashed' ? '8 4'
        : element.style === 'dotted' ? '2 2'
        : element.style === 'dashDot' ? '8 4 2 4'
        : element.style === 'longDash' ? '16 4'
        : element.style === 'longDashDot' ? '16 4 2 4'
        : undefined
      const [lineStartPt, lineEndPt] = element.points || ['', '']
      const lineMarkEnd = `ss-marker-end-${element.id}`
      const lineMarkStart = `ss-marker-start-${element.id}`
      const endMarker = getLineMarkerConfig(lineEndPt)
      const startMarker = getLineMarkerConfig(lineStartPt)
      const lineShadow = element.shadow
        ? buildDropShadowFilter(element.shadow)
        : undefined

      const linePathD = getLinePathD(element)

      return (
        <svg width="100%" height="100%" style={{ overflow: 'visible', filter: lineShadow }}>
          <defs>
            {lineEndPt !== '' && (
              <marker
                id={lineMarkEnd}
                markerWidth={endMarker.width}
                markerHeight={endMarker.height}
                refX={endMarker.refX}
                refY={endMarker.refY}
                orient="auto"
              >
                {renderLineMarker(lineEndPt, lineColor, false)}
              </marker>
            )}
            {lineStartPt !== '' && (
              <marker
                id={lineMarkStart}
                markerWidth={startMarker.width}
                markerHeight={startMarker.height}
                refX={startMarker.startRefX}
                refY={startMarker.refY}
                orient="auto"
              >
                {renderLineMarker(lineStartPt, lineColor, true)}
              </marker>
            )}
          </defs>
          <path
            d={linePathD}
            fill="none"
            stroke={lineColor}
            strokeWidth={lineW}
            strokeDasharray={lineDash}
            markerEnd={lineEndPt !== '' ? `url(#${lineMarkEnd})` : undefined}
            markerStart={lineStartPt !== '' ? `url(#${lineMarkStart})` : undefined}
          />
        </svg>
      )
    }

    case 'table': {
      const tblOutline = element.outline || { style: 'solid' as const, width: 1, color: '#d0d0d0' }
      const innerBorderVisible = (element.borders?.insideH?.width ?? element.borders?.insideV?.width) != null
        ? ((element.borders?.insideH?.width || 0) > 0 || (element.borders?.insideV?.width || 0) > 0)
        : tblOutline.width > 0
      const tblThemeColors = getTableThemeColors(element.theme, tblOutline.color, innerBorderVisible)
      const tblTotalRows = element.data.length
      const tblTotalCols = getTableColumnCount(element.data)
      const normalizedColWidths = normalizeTableColWidths(element.colWidths, tblTotalCols)
      const outerBorderSpecs = resolveTableOuterBorderSpecs(tblOutline, element.borders)
      const normalizedRowHeights = element.rowHeights?.length
        ? normalizeTableRowHeights(
            element.rowHeights,
            tblTotalRows,
            { totalHeight: element.height, minHeight: element.cellMinHeight || 0 },
          )
        : undefined
      return (
        <>
          <style>{`.tabslide-ss-table-${element.id} td p { margin: 0; }`}</style>
          <table
            className={`tabslide-ss-table-${element.id}`}
            style={{
              width: '100%',
              height: '100%',
              borderCollapse: 'collapse',
              tableLayout: 'fixed',
              border: 'none',
              borderTop: tableBorderSpecToCss(outerBorderSpecs.top),
              borderRight: tableBorderSpecToCss(outerBorderSpecs.right),
              borderBottom: tableBorderSpecToCss(outerBorderSpecs.bottom),
              borderLeft: tableBorderSpecToCss(outerBorderSpecs.left),
            }}
          >
            {normalizedColWidths && (
              <colgroup>
                {normalizedColWidths.map((w, i) => (
                  <col key={i} style={{ width: `${w * 100}%` }} />
                ))}
              </colgroup>
            )}
            <tbody>
              {element.data.map((row, ri) => (
                <tr key={ri} style={normalizedRowHeights?.[ri] ? { height: normalizedRowHeights[ri] } : undefined}>
                  {row.map((cell, ci) => {
                    if (cell.colspan === 0 || cell.rowspan === 0) return null
                    const cts = getCellThemeStyle(cell, ri, ci, tblTotalRows, tblTotalCols, element.theme, tblThemeColors)
                    const style = resolveTableCellStyle(cell)
                    const borderSpecs = resolveTableCellBorderSpecs({
                      rowIdx: ri,
                      colIdx: ci,
                      totalRows: tblTotalRows,
                      totalCols: tblTotalCols,
                      cell,
                      outline: tblOutline,
                      borders: element.borders,
                      fallbackInsideHColor: tblThemeColors.borderBottomColor,
                      fallbackInsideVColor: tblThemeColors.borderRightColor,
                    })
                    return (
                      <td
                        key={cell.id}
                        colSpan={cell.colspan ?? 1}
                        rowSpan={cell.rowspan ?? 1}
                        style={{
                          padding: '6px 10px',
                          borderTop: tableBorderSpecToCss(borderSpecs.top),
                          borderRight: tableBorderSpecToCss(borderSpecs.right),
                          borderBottom: tableBorderSpecToCss(borderSpecs.bottom),
                          borderLeft: tableBorderSpecToCss(borderSpecs.left),
                          color: cts.textColor || style.color || t.textPrimary,
                          backgroundColor: cts.bgColor,
                          fontSize: style.fontSize ? `${style.fontSize}pt` : '14pt',
                          fontWeight: cts.bold ? 'bold' : 'normal',
                          fontStyle: style.italic ? 'italic' : undefined,
                          textDecoration: style.underline ? 'underline' : undefined,
                          fontFamily: style.fontName || style.fontFamily,
                          textAlign:
                            (style.align as React.CSSProperties['textAlign']) || 'left',
                          verticalAlign: style.verticalAlign || 'middle',
                          minHeight: normalizedRowHeights?.[ri] || element.cellMinHeight || 36,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {cell.richText ? (
                          <div
                            style={{ margin: 0, lineHeight: 1.4 }}
                            dangerouslySetInnerHTML={{ __html: sanitizeHtml(cell.richText) }}
                          />
                        ) : (
                          cell.text
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )
    }

    case 'chart':
      return <ChartElement element={element} />

    case 'latex':
      if (element.svg) {
        return (
          <div
            style={{ width: '100%', height: '100%', color: element.color || t.textPrimary }}
            dangerouslySetInnerHTML={{ __html: normalizeLatexSvgForDisplay(element.svg) }}
          />
        )
      }
      if (element.path && element.viewBox) {
        return (
          <svg
            width="100%"
            height="100%"
            viewBox={`0 0 ${element.viewBox?.[0] ?? element.width} ${element.viewBox?.[1] ?? element.height}`}
            preserveAspectRatio="xMidYMid meet"
          >
            <path
              d={element.path}
              fill={element.color}
              strokeWidth={element.strokeWidth}
            />
          </svg>
        )
      }
      if (element.rasterSrc) {
        return (
          <img
            src={element.rasterSrc}
            alt={element.latex || 'LaTeX'}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            draggable={false}
          />
        )
      }
      return (
        <div style={{ padding: 8, fontFamily: 'serif', color: t.textSecondary }}>
          {element.latex}
        </div>
      )

    case 'video':
      return <SlideShowVideoMedia element={element} />

    case 'audio':
      return <SlideShowAudioMedia element={element} />

    default:
      return null
  }
}

type SlideShowVideoElement = Extract<PPTElement, { type: 'video' }>
type SlideShowAudioElement = Extract<PPTElement, { type: 'audio' }>

const hintWrapStyle: React.CSSProperties = {
  position: 'absolute',
  left: '50%',
  bottom: 10,
  transform: 'translateX(-50%)',
  background: MEDIA_HINT_BG,
  color: MEDIA_HINT_FG,
  fontSize: 12,
  lineHeight: '16px',
  padding: '5px 10px',
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  zIndex: 4,
}

const hintBtnStyle: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.35)',
  background: 'rgba(255,255,255,0.12)',
  color: MEDIA_HINT_FG,
  fontSize: 12,
  lineHeight: '14px',
  borderRadius: 4,
  padding: '2px 8px',
  cursor: 'pointer',
}

const SlideShowVideoMedia: React.FC<{ element: SlideShowVideoElement }> = ({ element }) => {
  const translate = useT()
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
    <div
      style={{ width: '100%', height: '100%', position: 'relative' }}
      data-slideshow-controls
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <video
        ref={mediaRef}
        src={element.src}
        poster={element.poster}
        autoPlay={element.autoplay}
        loop={element.loop}
        controls
        playsInline
        preload="metadata"
        onCanPlay={onCanPlay}
        onPlaying={onPlaying}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          background: STAGE_BG,
        }}
      />
      {autoplayBlocked && (
        <div style={hintWrapStyle}>
          <span>{translate('slideshow.autoplayRestricted')}</span>
          <button
            type="button"
            style={hintBtnStyle}
            onClick={(e) => {
              e.stopPropagation()
              void retryPlay({ withSound: true })
            }}
          >
            {translate('slideshow.clickToPlay')}
          </button>
        </div>
      )}
      {!autoplayBlocked && autoplayMuted && (
        <div style={hintWrapStyle}>
          <span>{translate('slideshow.autoplayMuted')}</span>
          <button
            type="button"
            style={hintBtnStyle}
            onClick={(e) => {
              e.stopPropagation()
              void retryPlay({ withSound: true })
            }}
          >
            {translate('slideshow.unmute')}
          </button>
        </div>
      )}
    </div>
  )
}

const SlideShowAudioMedia: React.FC<{ element: SlideShowAudioElement }> = ({ element }) => {
  const translate = useT()
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
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
      }}
      data-slideshow-controls
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <audio
        ref={mediaRef}
        src={element.src}
        autoPlay={element.autoplay}
        loop={element.loop}
        controls
        preload="metadata"
        onCanPlay={onCanPlay}
        onPlaying={onPlaying}
        onClick={(e) => e.stopPropagation()}
        style={{ width: '80%' }}
      />
      <span style={{ fontSize: 48, color: element.color || t.textSecondary }}>♪</span>
      {autoplayBlocked && (
        <div style={hintWrapStyle}>
          <span>{translate('slideshow.autoplayRestricted')}</span>
          <button
            type="button"
            style={hintBtnStyle}
            onClick={(e) => {
              e.stopPropagation()
              void retryPlay({ withSound: true })
            }}
          >
            {translate('slideshow.clickToPlay')}
          </button>
        </div>
      )}
    </div>
  )
}

type SlideShowLine = Extract<PPTElement, { type: 'line' }>
type SlideShowLinePoint = SlideShowLine['points'][number]

function getLineMarkerConfig(point: SlideShowLinePoint) {
  if (point === 'dot') return { width: 8, height: 8, refX: 6, startRefX: 2, refY: 4 }
  if (point === 'diamond') return { width: 10, height: 10, refX: 10, startRefX: 0, refY: 5 }
  if (point === 'stealth') return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
  if (point === 'triangle') return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
  return { width: 10, height: 8, refX: 10, startRefX: 0, refY: 4 }
}

function renderLineMarker(point: SlideShowLinePoint, color: string, start: boolean) {
  if (point === 'dot') return <circle cx="4" cy="4" r="2.5" fill={color} />
  if (point === 'diamond') {
    return start
      ? <polygon points="10 5,5 0,0 5,5 10" fill={color} />
      : <polygon points="0 5,5 0,10 5,5 10" fill={color} />
  }
  if (point === 'stealth') {
    return start
      ? <polygon points="10 0,2.5 4,10 8,6.5 4" fill={color} />
      : <polygon points="0 0,7.5 4,0 8,3.5 4" fill={color} />
  }
  if (point === 'triangle') {
    return start
      ? <polygon points="10 0,0 4,10 8" fill={color} />
      : <polygon points="0 0,10 4,0 8" fill={color} />
  }
  return start
    ? <polygon points="10 0,0 4,10 8" fill={color} />
    : <polygon points="0 0,10 4,0 8" fill={color} />
}
