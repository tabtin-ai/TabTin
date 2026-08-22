import { beforeEach, describe, expect, it } from 'vitest'
import { useSlideStore } from '../../../../../packages/tabslide/src/store/slide'
import {
  alignRight,
  alignToCanvasHCenter,
  distributeHorizontal,
  executeAlign,
  alignToCanvasCenter,
  alignToCanvasVCenter,
  tidyUp,
} from '../../../../../packages/tabslide/src/utils/align'
import type {
  PPTLineElement,
  PPTTextElement,
} from '../../../../../packages/tabslide/src/types/slides'
import { DEFAULT_EDITOR_CONFIG } from '../../../../../packages/tabslide/src/types/slides'

const makeText = (id: string, x: number, y: number, width: number, height: number): PPTTextElement => ({
  id,
  type: 'text',
  x,
  y,
  width,
  height,
  rotate: 0,
  opacity: 1,
  locked: false,
  content: `<p>${id}</p>`,
  defaultFontName: 'Arial',
  defaultColor: '#111111',
})

const makeGroupedText = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  groupId: string,
  locked = false,
): PPTTextElement => ({
  ...makeText(id, x, y, width, height),
  groupId,
  locked,
})

const makeVerticalLine = (id: string, x: number): PPTLineElement => ({
  id,
  type: 'line',
  x,
  y: 100,
  width: 1,
  height: 120,
  rotate: 0,
  opacity: 1,
  locked: false,
  start: [0, 0],
  end: [0, 120],
  style: 'solid',
  color: '#333333',
  lineWidth: 2,
  points: ['', ''],
})

describe('TabSlide Align & Snap Chain', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
    useSlideStore.getState().resetEditorConfig()
  })

  it('多元素垂直居中对齐应让中心线一致', () => {
    const a = makeText('a', 40, 10, 120, 40)
    const b = makeText('b', 260, 210, 80, 100)

    const updates = executeAlign('verticalCenter', [a, b], 800, 600)
    expect(updates).toHaveLength(2)

    const map = new Map(updates.map((u) => [u.id, u]))
    const nextA = map.get('a')
    const nextB = map.get('b')
    expect(nextA).toBeDefined()
    expect(nextB).toBeDefined()

    const centerA = (nextA?.y || 0) + a.height / 2
    const centerB = (nextB?.y || 0) + b.height / 2
    expect(centerA).toBeCloseTo(centerB, 6)
  })

  it('线条画布水平居中应按真实几何宽度计算，不应产生 4px 偏移', () => {
    const line = makeVerticalLine('line-1', 30)
    const updates = alignToCanvasHCenter([line], 200)

    expect(updates).toHaveLength(1)
    expect(updates[0]?.x).toBeCloseTo(99.5, 6)
  })

  it('多元素右对齐时，组合元素应作为整体移动，保持组内相对间距', () => {
    const g1a = makeGroupedText('g1-a', 100, 60, 80, 40, 'g-1')
    const g1b = makeGroupedText('g1-b', 240, 60, 70, 40, 'g-1')
    const solo = makeText('solo', 500, 60, 100, 40)

    const updates = alignRight([g1a, g1b, solo])
    const map = new Map(updates.map((u) => [u.id, u]))
    const nextA = map.get('g1-a')
    const nextB = map.get('g1-b')

    expect(nextA).toBeDefined()
    expect(nextB).toBeDefined()
    expect(nextA?.x).toBeCloseTo(390, 6)
    expect(nextB?.x).toBeCloseTo(530, 6)
    // 组内间距应保持不变（240 - 100 = 140）
    expect((nextB?.x || 0) - (nextA?.x || 0)).toBeCloseTo(140, 6)
  })

  it('水平均匀分布时，组合元素应作为一个分布单元', () => {
    const g1a = makeGroupedText('g1-a', 100, 80, 80, 40, 'g-1')
    const g1b = makeGroupedText('g1-b', 240, 80, 80, 40, 'g-1')
    const mid = makeText('mid', 500, 80, 120, 40)
    const g2a = makeGroupedText('g2-a', 900, 80, 90, 40, 'g-2')
    const g2b = makeGroupedText('g2-b', 1020, 80, 70, 40, 'g-2')

    const updates = distributeHorizontal([g1a, g1b, mid, g2a, g2b])
    const map = new Map(updates.map((u) => [u.id, u]))

    expect(map.get('g1-a')?.x).toBeCloseTo(100, 6)
    expect(map.get('g1-b')?.x).toBeCloseTo(240, 6)
    expect(map.get('mid')?.x).toBeCloseTo(550, 6)
    expect(map.get('g2-a')?.x).toBeCloseTo(900, 6)
    expect(map.get('g2-b')?.x).toBeCloseTo(1020, 6)
    // 组内相对间距保持（g2: 1020 - 900 = 120）
    expect((map.get('g2-b')?.x || 0) - (map.get('g2-a')?.x || 0)).toBeCloseTo(120, 6)
  })

  it('组内任一元素锁定时，整组应视为不可移动单元', () => {
    const g1a = makeGroupedText('g1-a', 80, 50, 120, 40, 'g-lock', true)
    const g1b = makeGroupedText('g1-b', 240, 50, 100, 40, 'g-lock', false)
    const solo = makeText('solo', 500, 50, 80, 40)

    const updates = alignRight([g1a, g1b, solo])
    // 可移动单元仅剩 1 个（solo）时，多元素对齐应无更新
    expect(updates).toHaveLength(0)
  })

  it('executeAlign canvasCenter 应将元素居中到画布中心', () => {
    const a = makeText('a', 10, 20, 100, 50)
    const updates = executeAlign('canvasCenter', [a], 800, 600)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.x).toBeCloseTo(350, 6)
    expect(updates[0]?.y).toBeCloseTo(275, 6)
  })

  it('executeAlign canvasHCenter 应水平居中到画布', () => {
    const a = makeText('a', 10, 200, 100, 50)
    const updates = executeAlign('canvasHCenter', [a], 800, 600)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.x).toBeCloseTo(350, 6)
    expect(updates[0]?.y).toBe(200)
  })

  it('executeAlign canvasVCenter 应垂直居中到画布', () => {
    const a = makeText('a', 100, 20, 100, 50)
    const updates = executeAlign('canvasVCenter', [a], 800, 600)
    expect(updates).toHaveLength(1)
    expect(updates[0]?.x).toBe(100)
    expect(updates[0]?.y).toBeCloseTo(275, 6)
  })

  it('executeAlign canvasCenter 多元素应整体居中到画布', () => {
    const a = makeText('a', 0, 0, 100, 50)
    const b = makeText('b', 200, 100, 100, 50)
    const updates = executeAlign('canvasCenter', [a, b], 800, 600)
    expect(updates).toHaveLength(2)
    const map = new Map(updates.map((u) => [u.id, u]))
    const ax = map.get('a')?.x ?? 0
    const bx = map.get('b')?.x ?? 0
    const groupLeft = Math.min(ax, bx)
    const groupRight = Math.max(ax + 100, bx + 100)
    const groupCenterX = (groupLeft + groupRight) / 2
    expect(groupCenterX).toBeCloseTo(400, 6)
  })

  it('tidyUp 应将不同高度的同行元素识别为同一行 (GEO-02)', () => {
    const tall = makeText('tall', 0, 0, 80, 120)
    const short = makeText('short', 150, 10, 80, 40)
    const updates = tidyUp([tall, short], { gapX: 20, gapY: 20 })
    expect(updates.length).toBeGreaterThanOrEqual(2)

    const map = new Map(updates.map((u) => [u.id, u]))
    const tallU = map.get('tall')!
    const shortU = map.get('short')!

    // 统一行高基准下，两元素应排在同一行（y 中心行相同）
    const rowStep = 120 + 20 // maxHeight + gapY
    const tallRow = Math.round(tallU.y / rowStep)
    const shortRow = Math.round(shortU.y / rowStep)
    expect(tallRow).toBe(shortRow)
  })

  it('tidyUp 不同高度元素不应因自身高度归一而错分行 (GEO-02 regression)', () => {
    const a = makeText('a', 0, 0, 60, 200)
    const b = makeText('b', 100, 0, 60, 30)
    const c = makeText('c', 200, 0, 60, 80)
    const updates = tidyUp([a, b, c], { gapX: 10, gapY: 10 })
    const map = new Map(updates.map((u) => [u.id, u]))

    // 全部 y=0 开头，应被识别为同一行
    const rowStep = 200 + 10
    const rows = ['a', 'b', 'c'].map((id) => Math.round((map.get(id)?.y ?? 0) / rowStep))
    expect(new Set(rows).size).toBe(1)
  })

  it('编辑器吸附配置应支持更新、校验和重置', () => {
    const store = useSlideStore.getState()

    store.updateEditorConfig({
      snapToGuides: false,
      snapToGrid: true,
      showGrid: true,
      gridSize: 24,
      snapThreshold: 3.336,
      minZoom: 0.2,
      maxZoom: 4.2,
    })

    let cfg = useSlideStore.getState().editorConfig
    expect(cfg.snapToGuides).toBe(false)
    expect(cfg.snapToGrid).toBe(true)
    expect(cfg.showGrid).toBe(true)
    expect(cfg.gridSize).toBe(24)
    expect(cfg.snapThreshold).toBe(3.34)
    expect(cfg.minZoom).toBe(0.2)
    expect(cfg.maxZoom).toBe(4.2)

    // 非法输入不应污染配置
    store.updateEditorConfig({
      gridSize: -10,
      snapThreshold: -1,
      minZoom: 0,
      maxZoom: 0,
    })
    cfg = useSlideStore.getState().editorConfig
    expect(cfg.gridSize).toBe(24)
    expect(cfg.snapThreshold).toBe(3.34)
    expect(cfg.minZoom).toBe(0.2)
    expect(cfg.maxZoom).toBe(4.2)

    store.resetEditorConfig()
    cfg = useSlideStore.getState().editorConfig
    expect(cfg).toEqual(DEFAULT_EDITOR_CONFIG)
  })
})
