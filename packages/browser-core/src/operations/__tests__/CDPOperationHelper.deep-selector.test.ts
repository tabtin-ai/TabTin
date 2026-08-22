/**
 * ：CDP click/hover 等走 queryMatchingNodeIds，深选择器须穿透 open shadow，
 * 不能将 ` >>> ` 整段交给 DOM.querySelectorAll。
 */
import { describe, it, expect, vi } from 'vitest'
import { CDPOperationHelper } from '../CDPOperationHelper'

type CDPHandler = (params: any) => any

function makeCtx(handlers: Record<string, CDPHandler>) {
  return {
    isAlive: () => true,
    sendCDP: vi.fn(async (method: string, params: any) => {
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected CDP method: ${method}`)
      return handler(params)
    }),
  } as any
}

const BOX = { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }

describe('queryMatchingNodeIds 深选择器', () => {
  it('浅 CSS 仍走 DOM.querySelectorAll', async () => {
    const querySelectorAll = vi.fn(() => ({ nodeIds: [42] }))
    const ctx = makeCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelectorAll': querySelectorAll,
    })

    const helper = new CDPOperationHelper()
    const ids = await (helper as any).queryMatchingNodeIds(ctx, '#id')

    expect(ids).toEqual([42])
    expect(querySelectorAll).toHaveBeenCalledWith({ nodeId: 1, selector: '#id' })
    expect(ctx.sendCDP).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
  })

  it('深选择器走 Runtime.evaluate(__tabtinDeepQuery) + DOM.requestNode', async () => {
    const releaseObject = vi.fn(() => ({}))
    const ctx = makeCtx({
      'Runtime.evaluate': (params: any) => {
        expect(params.returnByValue).toBe(false)
        expect(params.expression).toContain('__tabtinDeepQuery')
        expect(params.expression).toContain('#host >>> #btn')
        return { result: { objectId: 'obj-deep' } }
      },
      'DOM.requestNode': () => ({ nodeId: 99 }),
      'Runtime.releaseObject': releaseObject,
    })

    const helper = new CDPOperationHelper()
    const ids = await (helper as any).queryMatchingNodeIds(ctx, '#host >>> #btn')

    expect(ids).toEqual([99])
    expect(releaseObject).toHaveBeenCalledWith({ objectId: 'obj-deep' })
    expect(ctx.sendCDP).not.toHaveBeenCalledWith('DOM.querySelectorAll', expect.anything())
  })

  it('深选择器未命中元素时返回空数组并释放 object', async () => {
    const releaseObject = vi.fn(() => ({}))
    const ctx = makeCtx({
      'Runtime.evaluate': () => ({ result: {} }),
      'Runtime.releaseObject': releaseObject,
    })

    const helper = new CDPOperationHelper()
    const ids = await (helper as any).queryMatchingNodeIds(ctx, '#host >>> #missing')

    expect(ids).toEqual([])
    expect(releaseObject).not.toHaveBeenCalled()
  })
})

describe('runAction click 深选择器', () => {
  it('click 经 resolveElementCenter 穿透 shadow 并成功派发鼠标事件', async () => {
    const ctx = makeCtx({
      'DOM.enable': () => ({}),
      'Runtime.enable': () => ({}),
      'Runtime.evaluate': (params: any) => {
        expect(params.expression).toContain('__tabtinDeepQuery')
        return { result: { objectId: 'obj-deep' } }
      },
      'DOM.requestNode': () => ({ nodeId: 99 }),
      'Runtime.releaseObject': () => ({}),
      'DOM.getBoxModel': () => BOX,
      'DOM.scrollIntoViewIfNeeded': () => ({}),
      'DOM.describeNode': () => ({ node: { backendNodeId: 990 } }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj99' } }),
      'Runtime.callFunctionOn': () => ({ result: { value: null } }),
      'Input.dispatchMouseEvent': () => ({}),
    })

    const helper = new CDPOperationHelper()
    const result = await helper.runAction(ctx, { action: 'click', selector: '#host >>> #btn' })

    expect(result.success).toBe(true)
    expect(ctx.sendCDP).not.toHaveBeenCalledWith('DOM.querySelectorAll', expect.anything())
  })
})
