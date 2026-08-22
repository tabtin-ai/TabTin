/**
 * useClipboard 单元测试
 *
 * 覆盖：
 * - 复制单个/多个元素
 * - 粘贴时 ID 重生成（Wave 2 回归测试）
 * - 跨页粘贴
 * - 剪切操作
 * - 组合关系（groupId）保持
 * - 锁定元素排除
 * - Table 嵌套 cell ID 重生成
 * - hasInternalClipboard 辅助函数
 * - [EI-013 回归] hasClipboard 响应式（Zustand store 驱动）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PPTElement, PPTTextElement, PPTImageElement } from '../../types/slides'

// ── 内部 ID 计数器，供 mock createElementId 使用 ──

let idCounter = 0

// ── ClipboardStore 真实简化实现（用于测试） ──

function createMockClipboardStore() {
  let state = {
    items: [] as PPTElement[],
    pasteOffset: 0,
    isCutting: false,
  }
  const listeners = new Set<() => void>()

  const store = {
    getState: () => ({
      ...state,
      setItems: (items: PPTElement[], cutting = false) => {
        state = { items, pasteOffset: 0, isCutting: cutting }
        listeners.forEach((l) => l())
      },
      incrementPasteOffset: (amount: number) => {
        state = { ...state, pasteOffset: state.pasteOffset + amount }
        listeners.forEach((l) => l())
      },
      resetPasteOffset: () => {
        state = { ...state, pasteOffset: 0 }
        listeners.forEach((l) => l())
      },
      setNotCutting: () => {
        state = { ...state, isCutting: false }
        listeners.forEach((l) => l())
      },
      clear: () => {
        state = { items: [], pasteOffset: 0, isCutting: false }
        listeners.forEach((l) => l())
      },
    }),
    setState: vi.fn(),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    destroy: vi.fn(),
  }

  const selector = (sel: (s: typeof state) => unknown) => sel(state)

  const useStore = Object.assign(selector, store)
  return { useStore, reset: () => { state = { items: [], pasteOffset: 0, isCutting: false } } }
}

let mockClipboardStore: ReturnType<typeof createMockClipboardStore>

// ── Mocks ──

vi.mock('react', async (importActual) => {
  const actual = await importActual<typeof import('react')>()
  return {
    ...actual,
    useCallback: <T>(fn: T) => fn,
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: vi.fn(),
  }
})

vi.mock('../../utils/id', () => ({
  createElementId: vi.fn(() => `el_mock_${++idCounter}`),
  regenerateNestedIds: vi.fn((el: Record<string, unknown>) => {
    if (el.type !== 'table') return
    const data = el.data as Array<Array<{ id?: string }>> | undefined
    if (!Array.isArray(data)) return
    for (const row of data) {
      for (const cell of row) {
        if (cell && typeof cell.id === 'string') {
          cell.id = `el_mock_${++idCounter}`
        }
      }
    }
  }),
}))

// ── Store mock 工厂 ──

function makeSlideState(overrides: Partial<{
  presentation: {
    pages: Array<{ id: string; elements: PPTElement[] }>
    canvasWidth: number
    canvasHeight: number
  }
  currentPageIndex: number
  selectedElementIds: string[]
}> = {}) {
  const defaultPage = { id: 'page_1', elements: [] as PPTElement[] }
  const state = {
    presentation: {
      pages: [defaultPage],
      canvasWidth: 1920,
      canvasHeight: 1080,
    },
    currentPageIndex: 0,
    selectedElementIds: [],
    ...overrides,
  }

  state.presentation = state.presentation ?? { pages: [defaultPage], canvasWidth: 1920, canvasHeight: 1080 }

  const storeState = {
    ...state,
    currentPage: () => state.presentation?.pages[state.currentPageIndex] ?? null,
    addElements: vi.fn(),
    deleteElements: vi.fn(),
    setState: vi.fn(),
  }

  return storeState
}

type MockSlideState = ReturnType<typeof makeSlideState>

let mockSlideState: MockSlideState
let mockHistoryPushSnapshot: ReturnType<typeof vi.fn>

vi.mock('../../store/slide', () => ({
  useSlideStore: {
    getState: vi.fn(() => mockSlideState),
    setState: vi.fn(),
  },
}))

vi.mock('../../store/history', () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      pushSnapshot: mockHistoryPushSnapshot,
    })),
  },
}))

vi.mock('../../store/clipboard', () => {
  mockClipboardStore = createMockClipboardStore()
  return { useClipboardStore: mockClipboardStore.useStore }
})

// ── 辅助：创建测试元素 ──

function makeTextElement(overrides: Partial<PPTTextElement> = {}): PPTTextElement {
  return {
    id: `el_${Math.random().toString(36).slice(2, 6)}`,
    type: 'text',
    x: 100,
    y: 100,
    width: 300,
    height: 80,
    rotate: 0,
    opacity: 1,
    locked: false,
    content: '<p>Hello</p>',
    defaultFontName: 'Arial',
    defaultColor: '#000',
    autoFit: 'resize',
    ...overrides,
  }
}

function makeImageElement(overrides: Partial<PPTImageElement> = {}): PPTImageElement {
  return {
    id: `el_${Math.random().toString(36).slice(2, 6)}`,
    type: 'image',
    x: 200,
    y: 200,
    width: 400,
    height: 300,
    rotate: 0,
    opacity: 1,
    locked: false,
    fixedRatio: true,
    src: 'https://example.com/image.png',
    ...overrides,
  }
}

// ── Tests ──

describe('useClipboard', () => {
  beforeEach(() => {
    idCounter = 0
    mockHistoryPushSnapshot = vi.fn()
    mockClipboardStore?.reset()
    vi.clearAllMocks()
  })

  // ────────────────────────────────────
  //  复制操作
  // ────────────────────────────────────

  describe('copy()', () => {
    it('复制单个元素时剪贴板包含该元素', async () => {
      const el = makeTextElement({ id: 'el_target' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_target'],
      })

      const { useClipboard, hasInternalClipboard } = await import('../useClipboard')
      const { copy } = useClipboard() as ReturnType<typeof useClipboard>

      ;(copy as () => void)()

      expect(hasInternalClipboard()).toBe(true)
    })

    it('复制多个元素时剪贴板包含所有选中元素', async () => {
      const el1 = makeTextElement({ id: 'el_a' })
      const el2 = makeImageElement({ id: 'el_b' })
      const el3 = makeTextElement({ id: 'el_c', locked: true })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el1, el2, el3] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_a', 'el_b', 'el_c'],
      })

      const { useClipboard, hasInternalClipboard } = await import('../useClipboard')
      const { copy } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()

      expect(hasInternalClipboard()).toBe(true)
    })

    it('无选中元素时 copy() 不改变剪贴板（hasInternalClipboard 仍为初始值）', async () => {
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: [],
      })

      const { useClipboard, hasInternalClipboard } = await import('../useClipboard')
      const { copy } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()

      expect(hasInternalClipboard()).toBe(false)
    })

    it('复制不包含不在页面中的 ID（鲁棒性）', async () => {
      const el = makeTextElement({ id: 'el_real' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_real', 'el_ghost'],
      })

      const { useClipboard, hasInternalClipboard } = await import('../useClipboard')
      const { copy } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()

      expect(hasInternalClipboard()).toBe(true)
    })
  })

  // ────────────────────────────────────
  //  粘贴操作 — 核心 Wave 2 回归测试
  // ────────────────────────────────────

  describe('paste() — ID 重生成（Wave 2 回归）', () => {
    it('粘贴单个元素时新元素获得全新 ID，与原 ID 不同', async () => {
      const originalEl = makeTextElement({ id: 'el_original_fixed' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [originalEl] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_original_fixed'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { copy, paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()
      ;(paste as () => void)()

      expect(mockSlideState.addElements).toHaveBeenCalledOnce()

      const [pastedElements] = mockSlideState.addElements.mock.calls[0] as [PPTElement[]]
      expect(pastedElements).toHaveLength(1)

      expect(pastedElements[0].id).not.toBe('el_original_fixed')
      expect(pastedElements[0].id).toMatch(/^el_mock_/)
    })

    it('粘贴多个元素时每个元素都获得独立的新 ID', async () => {
      const el1 = makeTextElement({ id: 'el_src_1' })
      const el2 = makeImageElement({ id: 'el_src_2' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el1, el2] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_src_1', 'el_src_2'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { copy, paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()
      ;(paste as () => void)()

      const [pastedElements] = mockSlideState.addElements.mock.calls[0] as [PPTElement[]]
      expect(pastedElements).toHaveLength(2)

      const newIds = pastedElements.map((e) => e.id)
      expect(newIds[0]).not.toBe(newIds[1])
      expect(newIds).not.toContain('el_src_1')
      expect(newIds).not.toContain('el_src_2')
    })

    it('粘贴时位置偏移 20px（每次粘贴累加）', async () => {
      const el = makeTextElement({ id: 'el_offset', x: 50, y: 60 })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_offset'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { copy, paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()

      ;(paste as () => void)()
      const [firstPaste] = mockSlideState.addElements.mock.calls[0] as [PPTElement[]]
      expect(firstPaste[0].x).toBe(70)
      expect(firstPaste[0].y).toBe(80)

      ;(paste as () => void)()
      const [secondPaste] = mockSlideState.addElements.mock.calls[1] as [PPTElement[]]
      expect(secondPaste[0].x).toBe(90)
      expect(secondPaste[0].y).toBe(100)
    })

    it('粘贴时调用 historyStore.pushSnapshot', async () => {
      const el = makeTextElement({ id: 'el_hist' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_hist'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { copy, paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()
      ;(paste as () => void)()

      expect(mockHistoryPushSnapshot).toHaveBeenCalledOnce()
    })

    it('剪贴板为空时 paste() 不执行任何操作', async () => {
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: [],
      })

      const { useClipboard } = await import('../useClipboard')
      const { paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(paste as () => void)()

      expect(mockSlideState.addElements).not.toHaveBeenCalled()
      expect(mockHistoryPushSnapshot).not.toHaveBeenCalled()
    })
  })

  // ────────────────────────────────────
  //  跨页粘贴
  // ────────────────────────────────────

  describe('跨页粘贴', () => {
    it('在第 0 页复制后切换到第 1 页粘贴，元素粘贴到当前页', async () => {
      const el = makeTextElement({ id: 'el_page0' })

      const pages = [
        { id: 'page_0', elements: [el] },
        { id: 'page_1', elements: [] as PPTElement[] },
      ]

      mockSlideState = makeSlideState({
        presentation: { pages, canvasWidth: 1920, canvasHeight: 1080 },
        currentPageIndex: 0,
        selectedElementIds: ['el_page0'],
      })

      const { useClipboard } = await import('../useClipboard')
      const hook = useClipboard() as ReturnType<typeof useClipboard>
      ;(hook.copy as () => void)()

      mockSlideState = makeSlideState({
        presentation: { pages, canvasWidth: 1920, canvasHeight: 1080 },
        currentPageIndex: 1,
        selectedElementIds: [],
      })

      ;(hook.paste as () => void)()

      expect(mockSlideState.addElements).toHaveBeenCalledOnce()

      const [pastedElements] = mockSlideState.addElements.mock.calls[0] as [PPTElement[]]
      expect(pastedElements[0].id).not.toBe('el_page0')
    })
  })

  // ────────────────────────────────────
  //  组合关系（groupId 映射）
  // ────────────────────────────────────

  describe('paste() — 组合关系保持', () => {
    it('同组元素粘贴后共享新的 groupId，且新 groupId 不同于原始 groupId', async () => {
      const el1 = makeTextElement({ id: 'el_g1', groupId: 'group_old' })
      const el2 = makeImageElement({ id: 'el_g2', groupId: 'group_old' })

      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el1, el2] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_g1', 'el_g2'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { copy, paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()
      ;(paste as () => void)()

      const [pastedElements] = mockSlideState.addElements.mock.calls[0] as [PPTElement[]]
      expect(pastedElements).toHaveLength(2)

      const [pasted1, pasted2] = pastedElements
      expect(pasted1.groupId).toBeDefined()
      expect(pasted1.groupId).toBe(pasted2.groupId)
      expect(pasted1.groupId).not.toBe('group_old')
    })

    it('不同组元素粘贴后各自持有独立的新 groupId', async () => {
      const el1 = makeTextElement({ id: 'el_ga1', groupId: 'group_A' })
      const el2 = makeImageElement({ id: 'el_gb1', groupId: 'group_B' })

      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el1, el2] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_ga1', 'el_gb1'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { copy, paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()
      ;(paste as () => void)()

      const [pastedElements] = mockSlideState.addElements.mock.calls[0] as [PPTElement[]]
      const [pasted1, pasted2] = pastedElements
      expect(pasted1.groupId).not.toBe(pasted2.groupId)
    })
  })

  // ────────────────────────────────────
  //  Table 嵌套 cell ID 重生成
  // ────────────────────────────────────

  describe('paste() — table cell ID 重生成', () => {
    it('table 元素粘贴后所有 cell ID 都被重新生成', async () => {
      const tableEl = {
        id: 'el_table',
        type: 'table' as const,
        x: 100,
        y: 100,
        width: 600,
        height: 300,
        rotate: 0,
        opacity: 1,
        locked: false,
        data: [
          [{ id: 'cell_1_1', content: 'A' }, { id: 'cell_1_2', content: 'B' }],
          [{ id: 'cell_2_1', content: 'C' }, { id: 'cell_2_2', content: 'D' }],
        ],
        colWidths: [300, 300],
        rowCount: 2,
        colCount: 2,
      } as unknown as PPTElement

      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [tableEl] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_table'],
      })

      const idModule = await import('../../utils/id')
      const regenerateSpy = vi.spyOn(idModule, 'regenerateNestedIds')

      const { useClipboard } = await import('../useClipboard')
      const { copy, paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()
      ;(paste as () => void)()

      expect(regenerateSpy).toHaveBeenCalledOnce()
    })
  })

  // ────────────────────────────────────
  //  剪切操作
  // ────────────────────────────────────

  describe('cut()', () => {
    it('剪切时删除原元素并写入剪贴板', async () => {
      const el = makeTextElement({ id: 'el_cut_target' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_cut_target'],
      })

      const { useClipboard, hasInternalClipboard } = await import('../useClipboard')
      const { cut } = useClipboard() as ReturnType<typeof useClipboard>
      ;(cut as () => void)()

      expect(mockSlideState.deleteElements).toHaveBeenCalledWith(['el_cut_target'])
      expect(hasInternalClipboard()).toBe(true)
      expect(mockHistoryPushSnapshot).toHaveBeenCalledOnce()
    })

    it('剪切锁定元素时跳过（锁定元素不可剪切）', async () => {
      const lockedEl = makeTextElement({ id: 'el_locked', locked: true })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [lockedEl] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_locked'],
      })

      const { useClipboard, hasInternalClipboard } = await import('../useClipboard')
      const { cut } = useClipboard() as ReturnType<typeof useClipboard>
      ;(cut as () => void)()

      expect(mockSlideState.deleteElements).not.toHaveBeenCalled()
      expect(hasInternalClipboard()).toBe(false)
    })

    it('剪切后粘贴第一次不产生偏移（isCutting=true 时首次 paste offset=0）', async () => {
      const el = makeTextElement({ id: 'el_cut_offset', x: 50, y: 60 })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_cut_offset'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { cut, paste } = useClipboard() as ReturnType<typeof useClipboard>
      ;(cut as () => void)()
      ;(paste as () => void)()

      const [pastedElements] = mockSlideState.addElements.mock.calls[0] as [PPTElement[]]
      expect(pastedElements[0].x).toBe(50)
      expect(pastedElements[0].y).toBe(60)
    })
  })

  // ────────────────────────────────────
  //  hasInternalClipboard 辅助函数
  // ────────────────────────────────────

  describe('hasInternalClipboard()', () => {
    it('初始状态返回 false', async () => {
      const { hasInternalClipboard } = await import('../useClipboard')
      expect(hasInternalClipboard()).toBe(false)
    })

    it('copy 后返回 true，与 hasClipboard 属性一致', async () => {
      const el = makeTextElement({ id: 'el_has' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_has'],
      })

      const { useClipboard, hasInternalClipboard } = await import('../useClipboard')
      const { copy } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()

      expect(hasInternalClipboard()).toBe(true)
    })
  })

  // ────────────────────────────────────
  //  quickDuplicate
  // ────────────────────────────────────

  describe('quickDuplicate()', () => {
    it('快速复制 = copy + paste，元素获得新 ID 且偏移', async () => {
      const el = makeTextElement({ id: 'el_dup', x: 100, y: 100 })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_dup'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { quickDuplicate } = useClipboard() as ReturnType<typeof useClipboard>
      ;(quickDuplicate as () => void)()

      expect(mockSlideState.addElements).toHaveBeenCalledOnce()
      const [pastedElements] = mockSlideState.addElements.mock.calls[0] as [PPTElement[]]
      expect(pastedElements[0].id).not.toBe('el_dup')
      expect(pastedElements[0].x).toBe(120)
    })
  })

  // ────────────────────────────────────
  //  [EI-013 回归] hasClipboard 响应式
  // ────────────────────────────────────

  describe('[EI-013] hasClipboard 响应式', () => {
    it('copy 后 hasClipboard 变为 true', async () => {
      const el = makeTextElement({ id: 'el_reactive' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_reactive'],
      })

      const { useClipboard } = await import('../useClipboard')
      const hook = useClipboard() as ReturnType<typeof useClipboard>

      expect(hook.hasClipboard).toBe(false)

      ;(hook.copy as () => void)()

      const hook2 = useClipboard() as ReturnType<typeof useClipboard>
      expect(hook2.hasClipboard).toBe(true)
    })

    it('hasClipboard 由 Zustand store 驱动，非模块级变量快照', async () => {
      const { hasInternalClipboard } = await import('../useClipboard')

      expect(hasInternalClipboard()).toBe(false)

      const el = makeTextElement({ id: 'el_store_driven' })
      mockSlideState = makeSlideState({
        presentation: { pages: [{ id: 'page_1', elements: [el] }], canvasWidth: 1920, canvasHeight: 1080 },
        selectedElementIds: ['el_store_driven'],
      })

      const { useClipboard } = await import('../useClipboard')
      const { copy } = useClipboard() as ReturnType<typeof useClipboard>
      ;(copy as () => void)()

      expect(hasInternalClipboard()).toBe(true)
    })
  })
})
