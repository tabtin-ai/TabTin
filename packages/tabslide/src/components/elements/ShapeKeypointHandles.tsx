import React, { useCallback, useRef } from 'react'
import type { PPTShapeElement } from '../../types/slides'
import type { ShapePathFormula } from '../../configs/shapes'
import { useSlideStore } from '../../store/slide'
import { useHistoryStore } from '../../store/history'
import { ZIndex } from '@tabtin/app-shell'

const HANDLE_SIZE = 10

interface KeypointHandlesProps {
  element: PPTShapeElement
  formula: ShapePathFormula
  keypoints: number[]
}

export const KeypointHandles: React.FC<KeypointHandlesProps> = ({ element, formula, keypoints }) => {
  const updateElement = useSlideStore((s) => s.updateElement)

  return (
    <>
      {keypoints.map((kp, idx) => (
        <KeypointHandle
          key={idx}
          index={idx}
          value={kp}
          element={element}
          formula={formula}
          onUpdate={(newVal) => {
            const newKp = [...keypoints]
            newKp[idx] = newVal
            // 更新 keypoints 和重新计算 path
            const newPath = formula.formula(element.width, element.height, newKp)
            updateElement(element.id, {
              keypoints: newKp,
              path: newPath,
            } as Partial<PPTShapeElement>)
          }}
        />
      ))}
    </>
  )
}

const KeypointHandle: React.FC<{
  index: number
  value: number
  element: PPTShapeElement
  formula: ShapePathFormula
  onUpdate: (newVal: number) => void
}> = ({ index, value, element, formula, onUpdate }) => {
  const draggingRef = useRef(false)
  const startRef = useRef({ mouseX: 0, mouseY: 0, value: 0 })

  // 计算控制点在元素内的位置（百分比 → px）
  const relative = formula.relative[index] || 'left'
  const [minVal, maxVal] = formula.range[index] || [0, 1]

  let posX: number
  let posY: number
  const w = element.width
  const h = element.height
  const shortSide = Math.max(1, Math.min(w, h))
  const cornerRadius = value * shortSide

  switch (relative) {
    case 'left':
      posX = value * w
      posY = h / 2
      break
    case 'right':
      posX = w - value * w
      posY = h / 2
      break
    case 'top':
      posX = w / 2
      posY = value * h
      break
    case 'bottom':
      posX = w / 2
      posY = h - value * h
      break
    case 'topLeft':
      posX = cornerRadius
      posY = cornerRadius
      break
    case 'topRight':
      posX = w - cornerRadius
      posY = cornerRadius
      break
    case 'bottomRight':
      posX = w - cornerRadius
      posY = h - cornerRadius
      break
    case 'bottomLeft':
      posX = cornerRadius
      posY = h - cornerRadius
      break
    default:
      posX = value * w
      posY = h / 2
  }

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    draggingRef.current = true
    startRef.current = { mouseX: e.clientX, mouseY: e.clientY, value }

    // P0-3: 拖拽开始时保存历史快照，使 keypoint 调节可撤销
    const presentation = useSlideStore.getState().presentation
    if (presentation) {
      useHistoryStore.getState().pushSnapshot(presentation.pages)
    }

    // P0-2: 读取当前 zoom，将屏幕像素正确转换为画布像素
    const zoom = useSlideStore.getState().zoom

    const onMove = (me: MouseEvent) => {
      if (!draggingRef.current) return
      const dx = me.clientX - startRef.current.mouseX
      const dy = me.clientY - startRef.current.mouseY

      // 根据 relative 方向计算 delta（屏幕像素 / zoom → 画布像素 → 百分比）
      let delta = 0
      switch (relative) {
        case 'left': delta = dx / zoom / w; break
        case 'right': delta = -dx / zoom / w; break
        case 'top': delta = dy / zoom / h; break
        case 'bottom': delta = -dy / zoom / h; break
        case 'topLeft': delta = (dx / zoom + dy / zoom) / (2 * shortSide); break
        case 'topRight': delta = (-dx / zoom + dy / zoom) / (2 * shortSide); break
        case 'bottomRight': delta = (-dx / zoom - dy / zoom) / (2 * shortSide); break
        case 'bottomLeft': delta = (dx / zoom - dy / zoom) / (2 * shortSide); break
      }

      const newVal = Math.min(maxVal, Math.max(minVal, startRef.current.value + delta))
      onUpdate(newVal)
    }

    const onUp = () => {
      draggingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [value, relative, w, h, minVal, maxVal, shortSide, onUpdate])

  return (
    <div
      onMouseDown={handleMouseDown}
      style={{
        position: 'absolute',
        left: posX - HANDLE_SIZE / 2,
        top: posY - HANDLE_SIZE / 2,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        cursor:
          relative === 'left' || relative === 'right'
            ? 'ew-resize'
            : relative === 'top' || relative === 'bottom'
              ? 'ns-resize'
              : (relative === 'topLeft' || relative === 'bottomRight' ? 'nwse-resize' : 'nesw-resize'),
        zIndex: ZIndex.sticky,
      }}
    >
      {/* 黄色菱形 */}
      <svg width={HANDLE_SIZE} height={HANDLE_SIZE} viewBox="0 0 10 10">
        <polygon
          points="5,0 10,5 5,10 0,5"
          fill="#f59e0b"
          stroke="#b45309"
          strokeWidth={1}
        />
      </svg>
    </div>
  )
}
