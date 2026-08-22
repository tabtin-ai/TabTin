import React from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { layoutSpy, loadDiffContents } = vi.hoisted(() => ({
  layoutSpy: vi.fn(),
  loadDiffContents: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@utils/cn', () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' '),
}))

vi.mock('@utils/monaco-setup', () => ({
  configureMonacoWorkers: vi.fn(),
}))

vi.mock('@/hooks/useMonacoThemeSync', () => ({
  useMonacoThemeSync: vi.fn(),
}))

vi.mock('@/utils/monaco-ide-theme', () => ({
  getMonacoIdeThemeName: () => 'tabtin-ide-dark',
  MONACO_IDE_FONT_FAMILY: 'monospace',
  MONACO_IDE_FONT_SIZE: 12,
  MONACO_IDE_LINE_HEIGHT: 18,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    log: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../../../context-space/code-workspace/changesPerfMetrics', () => ({
  markFirstDiffReady: vi.fn(),
  trackMonacoDispose: vi.fn(),
  trackMonacoMount: vi.fn(),
}))

vi.mock('../diffContentCache', () => ({
  loadDiffContents,
}))

vi.mock('monaco-editor/esm/vs/editor/editor.api', () => {
  const createModel = (value: string) => ({
    getValue: () => value,
    setValue: vi.fn(),
    dispose: vi.fn(),
  })
  return {
    editor: {
      createDiffEditor: () => ({
        layout: layoutSpy,
        setModel: vi.fn(),
        updateOptions: vi.fn(),
        getModifiedEditor: () => ({
          updateOptions: vi.fn(),
          revealLineInCenter: vi.fn(),
          setPosition: vi.fn(),
          getContentHeight: () => 120,
          onDidContentSizeChange: () => ({ dispose: vi.fn() }),
        }),
        getOriginalEditor: () => ({
          updateOptions: vi.fn(),
        }),
        getLineChanges: () => [{
          originalStartLineNumber: 1,
          originalEndLineNumber: 1,
          modifiedStartLineNumber: 1,
          modifiedEndLineNumber: 1,
        }],
        onDidUpdateDiff: (fn: () => void) => {
          queueMicrotask(fn)
          return { dispose: vi.fn() }
        },
        dispose: vi.fn(),
      }),
      createModel,
      setModelLanguage: vi.fn(),
    },
  }
})

import TabCodeDiffView from '../TabCodeDiffView'

describe('TabCodeDiffView layout after hidden mount', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')

  beforeEach(() => {
    layoutSpy.mockReset()
    loadDiffContents.mockReset()
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
    })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return (this as HTMLElement).style.display === 'none' ? 0 : 800
      },
    })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return (this as HTMLElement).style.display === 'none' ? 0 : 480
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    } else {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    }
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
    } else {
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    }
  })

  it('异步内容就绪且 ResizeObserver 不回调时，仍以非零尺寸 layout', async () => {
    let resolveLoad: ((value: { left: string; right: string }) => void) | undefined
    loadDiffContents.mockImplementation(() => new Promise((resolve) => {
      resolveLoad = resolve
    }))
    const onDiffReady = vi.fn()

    render(
      <div style={{ width: 800, height: 480 }}>
        <TabCodeDiffView
          rootPath="/repo"
          filePath="/repo/a.ts"
          language="typescript"
          onDiffReady={onDiffReady}
        />
      </div>,
    )

    expect(layoutSpy.mock.calls.every((call) => {
      const dim = call[0] as { width?: number; height?: number } | undefined
      return !dim || dim.width === 0 || dim.height === 0 || dim.width == null
    })).toBe(true)

    await waitFor(() => {
      expect(loadDiffContents).toHaveBeenCalled()
      expect(resolveLoad).toBeTypeOf('function')
    })
    await act(async () => {
      resolveLoad?.({ left: 'old line\n', right: 'new line\n' })
    })

    await waitFor(() => {
      const sized = layoutSpy.mock.calls.find((call) => {
        const dim = call[0] as { width?: number; height?: number } | undefined
        return (dim?.width ?? 0) > 0 && (dim?.height ?? 0) > 0
      })
      expect(sized).toBeTruthy()
    })
    await waitFor(() => {
      expect(onDiffReady).toHaveBeenCalledWith(expect.objectContaining({ hasChanges: true }))
    })
  })

  it('文本相同但权限变化时显示属性变更，而不是无变更', async () => {
    loadDiffContents.mockResolvedValue({
      left: 'same\n',
      right: 'same\n',
      metadataChange: { oldMode: '100644', newMode: '100755' },
    })

    render(
      <TabCodeDiffView
        rootPath="/repo"
        filePath="/repo/tool.sh"
        language="shell"
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('diff.metadataChanged')).toBeTruthy()
    })
    expect(screen.queryByText('diff.noChanges')).toBeNull()
    expect(screen.getByText('100644 → 100755')).toBeTruthy()
    expect(screen.getByText('diff.contentUnchanged')).toBeTruthy()
  })
})
