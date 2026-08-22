import { describe, expect, it, vi } from 'vitest'
import type { BrowserContext } from '../../context/BrowserContext'
import { SOM_EMPTY_COLLECT_RETRY_DELAYS_MS, SoMService, type SoMElement } from '../SoMService'

function element(name: string): SoMElement {
  return {
    id: 1,
    tag: 'button',
    role: 'button',
    name,
    selector: `#${name}`,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    visible: true,
    interactive: true,
  }
}

function makeContext(
  results: Record<string, { elements: SoMElement[]; totalCandidates: number } | Error>,
): BrowserContext {
  return {
    isAlive: () => true,
    listChildFrameIds: () => ['child-1', 'child-2'],
    executeScript: vi.fn(async (_code: string, frameId?: string) => {
      const result = results[frameId ?? 'main']
      if (result instanceof Error) throw result
      return result
    }),
  } as unknown as BrowserContext
}

describe('SoMService frame collection', () => {
  it('按主 frame 优先顺序合并元素并重新分配全局 id', async () => {
    const context = makeContext({
      main: { elements: [element('main')], totalCandidates: 1 },
      'child-1': { elements: [element('child-one')], totalCandidates: 1 },
      'child-2': { elements: [element('child-two')], totalCandidates: 1 },
    })

    const result = await new SoMService().collectInteractiveElements(context)

    expect(result.elements.map(({ id, name, frameId }) => ({ id, name, frameId }))).toEqual([
      { id: 1, name: 'main', frameId: undefined },
      { id: 2, name: 'child-one', frameId: 'child-1' },
      { id: 3, name: 'child-two', frameId: 'child-2' },
    ])
    expect(result.totalCandidates).toBe(3)
    expect(result.truncated).toBe(false)
  })

  it('全局 limit 截断合并结果但保留所有 frame 的候选总数', async () => {
    const context = makeContext({
      main: { elements: [element('main')], totalCandidates: 1 },
      'child-1': {
        elements: [element('child-one'), element('child-one-more')],
        totalCandidates: 2,
      },
      'child-2': { elements: [element('child-two')], totalCandidates: 1 },
    })

    const result = await new SoMService().collectInteractiveElements(context, { limit: 2 })

    expect(result.elements.map((entry) => entry.name)).toEqual(['main', 'child-one'])
    expect(result.totalCandidates).toBe(4)
    expect(result.truncated).toBe(true)
  })

  it('单个子 frame 执行失败时仍返回其他 frame 的元素', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const context = makeContext({
      main: { elements: [element('main')], totalCandidates: 1 },
      'child-1': new Error('detached'),
      'child-2': { elements: [element('child-two')], totalCandidates: 1 },
    })

    const result = await new SoMService().collectInteractiveElements(context)

    expect(result.elements.map((entry) => entry.name)).toEqual(['main', 'child-two'])
    expect(errorSpy).toHaveBeenCalledOnce()
    errorSpy.mockRestore()
  })

  it('frame 列举在页面销毁竞态下失败时降级为主 frame 结果', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const context = {
      isAlive: () => true,
      listChildFrameIds: () => {
        throw new Error('web contents destroyed')
      },
      executeScript: vi.fn(async () => ({
        elements: [element('main')],
        totalCandidates: 1,
      })),
    } as unknown as BrowserContext

    const result = await new SoMService().collectInteractiveElements(context)

    expect(result.elements.map((entry) => entry.name)).toEqual(['main'])
    expect(errorSpy).toHaveBeenCalledWith(
      '[SoMService] listChildFrameIds failed:',
      expect.any(Error),
    )
    errorSpy.mockRestore()
  })

  it('子 frame 首轮仍在加载时会触发后续重采', async () => {
    vi.useFakeTimers()
    const childResults = [
      { elements: [], totalCandidates: 0 },
      { elements: [element('child-ready')], totalCandidates: 1 },
    ]
    const context = {
      isAlive: () => true,
      listChildFrameIds: () => ['child-1'],
      executeScript: vi.fn(async (_code: string, frameId?: string) => {
        if (!frameId) return { elements: [element('main')], totalCandidates: 1 }
        return childResults.shift() ?? { elements: [element('child-ready')], totalCandidates: 1 }
      }),
    } as unknown as BrowserContext

    const pending = new SoMService().collectInteractiveElements(context)
    await vi.advanceTimersByTimeAsync(SOM_EMPTY_COLLECT_RETRY_DELAYS_MS[0])
    const result = await pending

    expect(result.elements.map((entry) => entry.name)).toEqual(['main', 'child-ready'])
    expect(context.executeScript).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })

  it('运行时未提供 frame 能力时保持单文档执行路径', async () => {
    const executeScript = vi.fn(async () => ({
      elements: [element('main')],
      totalCandidates: 1,
    }))
    const context = {
      isAlive: () => true,
      executeScript,
    } as unknown as BrowserContext

    const result = await new SoMService().collectInteractiveElements(context)

    expect(result.elements).toHaveLength(1)
    expect(executeScript).toHaveBeenCalledOnce()
    expect(executeScript).toHaveBeenCalledWith(expect.any(String))
  })

  it('截图标号只注入主 frame 元素，避免误用子 frame 局部坐标', async () => {
    let overlayScript = ''
    const context = {
      isAlive: () => true,
      listChildFrameIds: () => ['child-1'],
      executeScript: vi.fn(async (code: string, frameId?: string) => {
        if (code.includes('const interactiveSelectors')) {
          return {
            elements: [element(frameId ? 'child' : 'main')],
            totalCandidates: 1,
          }
        }
        if (code.includes('const marks =')) overlayScript = code
        return undefined
      }),
      captureScreenshot: vi.fn(async () => Buffer.from('image')),
    } as unknown as BrowserContext

    const result = await new SoMService().captureAnnotated(context)

    expect(result.elements).toHaveLength(2)
    expect(overlayScript).toContain('{"id":1,"x":0,"y":0}')
    expect(overlayScript).not.toContain('{"id":2,"x":0,"y":0}')
  })
})
