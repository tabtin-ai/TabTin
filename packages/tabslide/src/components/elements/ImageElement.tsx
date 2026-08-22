import React, { useState, useCallback, useRef } from 'react'
import type { PPTImageElement } from '../../types/slides'
import { useSlideStore } from '../../store/slide'
import { useHistoryStore } from '../../store/history'
import { buildShadowStyle } from '../../utils/geometry'
import * as t from '../../theme'
import { useT } from '../../i18n'
import { ZIndex } from '@tabtin/app-shell'

interface ImageElementProps {
  element: PPTImageElement
  isEditing?: boolean
}

/**
 * 图片元素
 *
 * 支持：
 * - 滤镜 / 翻转 / 颜色蒙版 / 圆角
 * - 双击进入裁剪模式（简化版：拖拽四边调节裁剪区域）
 * - 加载中 / 加载失败兜底 UI
 */
const ImageElement: React.FC<ImageElementProps> = ({ element, isEditing }) => {
  const tFunc = useT()
  const updateElement = useSlideStore((s) => s.updateElement)
  const setEditing = useSlideStore((s) => s.setEditing)

  // 图片加载状态
  const [imgStatus, setImgStatus] = useState<'loading' | 'loaded' | 'error'>(
    element.src ? 'loading' : 'error',
  )

  // 注入 spinner keyframes（只执行一次）
  React.useEffect(() => {
    const id = 'tabslide-spin-style'
    if (!document.getElementById(id)) {
      const style = document.createElement('style')
      style.id = id
      style.textContent = '@keyframes tabslide-spin { to { transform: rotate(360deg) } }'
      document.head.appendChild(style)
    }
  }, [])

  // 裁剪状态（百分比 0-1）
  const [crop, setCrop] = useState({
    top: 0, right: 0, bottom: 0, left: 0,
  })
  const [isCropping, setIsCropping] = useState(false)

  // 进入裁剪模式
  React.useEffect(() => {
    if (isEditing) {
      setIsCropping(true)
      if (element.clip?.range && element.clip.range.length >= 4) {
        const r = element.clip.range
        setCrop({
          top: r[0]?.[1] ?? 0,
          right: 1 - (r[1]?.[0] ?? 1),
          bottom: 1 - (r[2]?.[1] ?? 1),
          left: r[0]?.[0] ?? 0,
        })
      } else {
        // B2-08: 椭圆裁剪 clip.range=[] 不满足 length>=4，
        // 重置为全零（无裁剪）而非保留上次的裁剪状态，避免视觉丢失。
        setCrop({ top: 0, right: 0, bottom: 0, left: 0 })
      }
    } else {
      setIsCropping(false)
    }
  }, [isEditing, element.clip])

  // 应用裁剪
  const applyCrop = useCallback(() => {
    const presentation = useSlideStore.getState().presentation
    if (presentation) {
      useHistoryStore.getState().pushSnapshot(presentation.pages)
    }
    const { top, right, bottom, left } = crop
    const hasAnyCrop = top > 0.01 || right > 0.01 || bottom > 0.01 || left > 0.01
    updateElement(element.id, {
      clip: hasAnyCrop ? {
        shape: 'rect',
        range: [
          [left, top],
          [1 - right, top],
          [1 - right, 1 - bottom],
          [left, 1 - bottom],
        ],
      } : undefined,
    } as Partial<PPTImageElement>)
    setEditing(null)
  }, [crop, element.id, updateElement, setEditing])

  // 应用圆形裁剪
  const applyCircleCrop = useCallback(() => {
    const presentation = useSlideStore.getState().presentation
    if (presentation) {
      useHistoryStore.getState().pushSnapshot(presentation.pages)
    }
    updateElement(element.id, {
      clip: { shape: 'ellipse', range: [] },
    } as Partial<PPTImageElement>)
    setEditing(null)
  }, [element.id, updateElement, setEditing])

  // 移除裁剪
  const removeCrop = useCallback(() => {
    const presentation = useSlideStore.getState().presentation
    if (presentation) {
      useHistoryStore.getState().pushSnapshot(presentation.pages)
    }
    updateElement(element.id, {
      clip: undefined,
    } as Partial<PPTImageElement>)
    setEditing(null)
  }, [element.id, updateElement, setEditing])

  const isCurrentlyEllipse = element.clip?.shape === 'ellipse'

  // 拖拽裁剪边
  const handleCropDrag = useCallback((side: 'top' | 'right' | 'bottom' | 'left') => (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const startCrop = { ...crop }

    const onMove = (me: MouseEvent) => {
      // B2-01: flipH/flipV 使 CSS scaleX(-1)/scaleY(-1) 包裹元素，
      // 屏幕坐标系下拖拽方向与逻辑方向相反，需取反补偿。
      const dx = (me.clientX - startX) * (element.flipH ? -1 : 1)
      const dy = (me.clientY - startY) * (element.flipV ? -1 : 1)
      const zoom = useSlideStore.getState().zoom || 1
      const w = element.width * zoom
      const h = element.height * zoom

      setCrop((prev) => {
        const next = { ...prev }
        switch (side) {
          case 'top': next.top = Math.max(0, Math.min(0.9, startCrop.top + dy / h)); break
          case 'bottom': next.bottom = Math.max(0, Math.min(0.9, startCrop.bottom - dy / h)); break
          case 'left': next.left = Math.max(0, Math.min(0.9, startCrop.left + dx / w)); break
          case 'right': next.right = Math.max(0, Math.min(0.9, startCrop.right - dx / w)); break
        }
        return next
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [crop, element.width, element.height])

  const filterStr = element.filters
    ? [
        element.filters.brightness !== undefined && `brightness(${element.filters.brightness})`,
        element.filters.contrast !== undefined && `contrast(${element.filters.contrast})`,
        element.filters.saturate !== undefined && `saturate(${element.filters.saturate})`,
        element.filters.blur !== undefined && `blur(${element.filters.blur}px)`,
        element.filters.grayscale !== undefined && `grayscale(${element.filters.grayscale})`,
        element.filters.invert !== undefined && `invert(${element.filters.invert})`,
        element.filters.hueRotate !== undefined && `hue-rotate(${element.filters.hueRotate}deg)`,
        element.filters.sepia !== undefined && `sepia(${element.filters.sepia})`,
      ]
        .filter(Boolean)
        .join(' ')
    : undefined

  // 翻转已由 ElementRenderer 容器统一处理

  // 应用裁剪的 clip-path（支持 rect/ellipse）
  // B2-08: 椭圆裁剪时即使处于裁剪模式也保留 clip-path，防止进入裁剪模式后椭圆视觉丢失。
  // 矩形裁剪模式下仍移除 clipPath，让裁剪手柄直接操作可见区域。
  const clipPath = (() => {
    if (!element.clip) return undefined
    if (element.clip.shape === 'ellipse') return 'ellipse(50% 50% at 50% 50%)'
    if (isCropping) return undefined
    if (element.clip.range && element.clip.range.length >= 4) {
      return `polygon(${element.clip.range.map((p) => `${p[0] * 100}% ${p[1] * 100}%`).join(', ')})`
    }
    return undefined
  })()

  // 阴影
  const shadowStyle = element.shadow
    ? buildShadowStyle(element.shadow)
    : undefined

  // 边框
  const outlineStyle = element.outline
    ? `${element.outline.width}px ${element.outline.style} ${element.outline.color}`
    : undefined

  // 当 src 变化时重置加载状态
  const prevSrcRef = useRef(element.src)
  React.useEffect(() => {
    if (prevSrcRef.current !== element.src) {
      setImgStatus('loading')
      prevSrcRef.current = element.src
    }
  }, [element.src])

  return (
    <div style={{
      width: '100%',
      height: '100%',
      position: 'relative',
      overflow: 'hidden',
      boxShadow: shadowStyle,
      // 使用 outline 而非 border：outline 不占用内部空间，与 PPTX 行为一致
      outline: outlineStyle,
      outlineOffset: element.outline ? `-${element.outline.width}px` : undefined,
      borderRadius: element.radius ? `${element.radius}px` : undefined,
    }}>
      {/* 加载状态占位 */}
      {imgStatus === 'loading' && element.src && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: t.bgMuted || '#f5f5f5',
          borderRadius: element.radius ? `${element.radius}px` : undefined,
          zIndex: 1,
        }}>
          <div style={{
            width: 24, height: 24,
            border: `2px solid ${t.border || '#ddd'}`,
            borderTopColor: t.accent || '#5b9bd5',
            borderRadius: '50%',
            animation: 'tabslide-spin 0.8s linear infinite',
          }} />
        </div>
      )}

      {/* 加载失败兜底 */}
      {imgStatus === 'error' && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: t.bgMuted || '#f5f5f5',
          borderRadius: element.radius ? `${element.radius}px` : undefined,
          color: t.textSecondary || '#999',
          fontSize: 12,
          gap: 4,
          zIndex: 1,
        }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-5-5L5 21" />
            <line x1="4" y1="4" x2="20" y2="20" strokeOpacity="0.5" />
          </svg>
          <span>{tFunc('image.loadFailed')}</span>
        </div>
      )}

      {element.src && (
        <img
          src={element.src}
          alt={element.altText || ''}
          onLoad={() => setImgStatus('loaded')}
          onError={() => setImgStatus('error')}
          style={{
            width: '100%',
            height: '100%',
            objectFit: element.objectFit || 'cover',
            borderRadius: element.radius ? `${element.radius}px` : undefined,
            filter: filterStr,
            // transform: 翻转已由 ElementRenderer 容器统一处理
            clipPath,
            opacity: imgStatus === 'loaded' ? 1 : 0,
            transition: 'opacity 0.15s ease',
          }}
          draggable={false}
        />
      )}
      {/* 颜色蒙版 */}
      {element.colorMask && !isCropping && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: element.colorMask,
            borderRadius: element.radius ? `${element.radius}px` : undefined,
            clipPath,
            pointerEvents: 'none',
          }}
        />
      )}

      {/* ── 裁剪模式 UI ── */}
      {isCropping && (
        <>
          {/* 暗色遮罩 — 上 */}
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            height: `${crop.top * 100}%`,
            background: 'rgba(0,0,0,0.5)', pointerEvents: 'none',
          }} />
          {/* 暗色遮罩 — 下 */}
          <div style={{
            position: 'absolute', bottom: 0, left: 0, right: 0,
            height: `${crop.bottom * 100}%`,
            background: 'rgba(0,0,0,0.5)', pointerEvents: 'none',
          }} />
          {/* 暗色遮罩 — 左 */}
          <div style={{
            position: 'absolute',
            top: `${crop.top * 100}%`,
            bottom: `${crop.bottom * 100}%`,
            left: 0,
            width: `${crop.left * 100}%`,
            background: 'rgba(0,0,0,0.5)', pointerEvents: 'none',
          }} />
          {/* 暗色遮罩 — 右 */}
          <div style={{
            position: 'absolute',
            top: `${crop.top * 100}%`,
            bottom: `${crop.bottom * 100}%`,
            right: 0,
            width: `${crop.right * 100}%`,
            background: 'rgba(0,0,0,0.5)', pointerEvents: 'none',
          }} />

          {/* 裁剪区域边框 */}
          <div style={{
            position: 'absolute',
            top: `${crop.top * 100}%`,
            left: `${crop.left * 100}%`,
            right: `${crop.right * 100}%`,
            bottom: `${crop.bottom * 100}%`,
            border: `2px dashed ${t.accent}`,
            pointerEvents: 'none',
          }} />

          {/* 拖拽手柄 — 上 */}
          <CropHandle side="top" crop={crop} onDrag={handleCropDrag('top')} />
          {/* 拖拽手柄 — 下 */}
          <CropHandle side="bottom" crop={crop} onDrag={handleCropDrag('bottom')} />
          {/* 拖拽手柄 — 左 */}
          <CropHandle side="left" crop={crop} onDrag={handleCropDrag('left')} />
          {/* 拖拽手柄 — 右 */}
          <CropHandle side="right" crop={crop} onDrag={handleCropDrag('right')} />

          {/* 确认/取消/圆形裁剪按钮 — 放在元素内部底部，避免被父容器 overflow:hidden 裁切 */}
          <div style={{
            position: 'absolute',
            bottom: 4,
            left: '50%',
            transform: 'translateX(-50%)',
            display: 'flex',
            gap: 4,
            zIndex: ZIndex.sticky,
          }}>
            <button
              onClick={(e) => { e.stopPropagation(); applyCrop() }}
              style={{
                border: 'none', background: t.accent, color: '#fff',
                padding: '3px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              {tFunc('image.confirm')}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); applyCircleCrop() }}
              title={tFunc('image.cropCircle')}
              style={{
                border: `1px solid ${isCurrentlyEllipse ? t.accent : t.border}`,
                background: isCurrentlyEllipse ? t.accent : t.bgApp,
                color: isCurrentlyEllipse ? '#fff' : t.textPrimary,
                padding: '3px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
              </svg>
            </button>
            {element.clip && (
              <button
                onClick={(e) => { e.stopPropagation(); removeCrop() }}
                title={tFunc('image.removeCrop')}
                style={{
                  border: `1px solid ${t.border}`, background: t.bgApp, color: t.textPrimary,
                  padding: '3px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
                }}
              >
                {tFunc('image.reset')}
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setEditing(null) }}
              style={{
                border: `1px solid ${t.border}`, background: t.bgApp, color: t.textPrimary,
                padding: '3px 12px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
              }}
            >
              {tFunc('image.cancel')}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── 裁剪手柄 ──

const CropHandle: React.FC<{
  side: 'top' | 'right' | 'bottom' | 'left'
  crop: { top: number; right: number; bottom: number; left: number }
  onDrag: (e: React.MouseEvent) => void
}> = ({ side, crop, onDrag }) => {
  const SIZE = 16
  const isH = side === 'top' || side === 'bottom'
  const cursor = isH ? 'ns-resize' : 'ew-resize'

  const style: React.CSSProperties = {
    position: 'absolute',
    zIndex: 5,
    cursor,
  }

  if (side === 'top') {
    Object.assign(style, {
      top: `${crop.top * 100}%`,
      left: '50%',
      transform: `translate(-50%, -${SIZE / 2}px)`,
      width: SIZE * 2,
      height: SIZE,
    })
  } else if (side === 'bottom') {
    Object.assign(style, {
      bottom: `${crop.bottom * 100}%`,
      left: '50%',
      transform: `translate(-50%, ${SIZE / 2}px)`,
      width: SIZE * 2,
      height: SIZE,
    })
  } else if (side === 'left') {
    Object.assign(style, {
      left: `${crop.left * 100}%`,
      top: '50%',
      transform: `translate(-${SIZE / 2}px, -50%)`,
      width: SIZE,
      height: SIZE * 2,
    })
  } else {
    Object.assign(style, {
      right: `${crop.right * 100}%`,
      top: '50%',
      transform: `translate(${SIZE / 2}px, -50%)`,
      width: SIZE,
      height: SIZE * 2,
    })
  }

  return (
    <div style={style} onMouseDown={onDrag}>
      <div style={{
        width: '100%',
        height: '100%',
        background: t.accent,
        borderRadius: 2,
        border: '1px solid #fff',
      }} />
    </div>
  )
}

export default React.memo(ImageElement)
