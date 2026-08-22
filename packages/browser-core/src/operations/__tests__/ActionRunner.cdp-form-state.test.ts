// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { runSingleAction } from '../ActionRunner'

const BOX = {
  model: {
    content: [0, 0, 10, 0, 10, 10, 0, 10],
    border: [0, 0, 10, 0, 10, 10, 0, 10],
  },
}

/**
 * 经 ActionRunner → CDPOperationHelper 的最小 CDP 页面夹具。
 * 浏览器默认行为由夹具显式更新 checked 状态，不调用 element.click() 替被测代码兜底。
 */
function makeCdpBackedCtx(
  selector: string,
  options: {
    applyCheckableDefaultAction?: boolean
    inspectionFails?: boolean
    postInspectionHangs?: boolean
  } = {},
) {
  const control = document.querySelector(selector) as HTMLElement
  if (!control) throw new Error(`missing control ${selector}`)
  const applyCheckableDefaultAction = options.applyCheckableDefaultAction ?? true
  let inspectionCount = 0

  return {
    isAlive: () => true,
    executeScript: vi.fn(async (script: string) => {
      // eslint-disable-next-line no-eval
      return eval(script)
    }),
    sendCDP: vi.fn(async (method: string, params: any) => {
      switch (method) {
        case 'DOM.enable':
        case 'Runtime.enable':
        case 'DOM.scrollIntoViewIfNeeded':
          return {}
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } }
        case 'DOM.querySelectorAll':
          return { nodeIds: [1] }
        case 'DOM.getBoxModel':
          return BOX
        case 'DOM.describeNode':
          return { node: { backendNodeId: 1 } }
        case 'DOM.resolveNode':
          return { object: { objectId: 'control-1' } }
        case 'Runtime.callFunctionOn':
          inspectionCount += 1
          if (options.postInspectionHangs && inspectionCount > 1) {
            return await new Promise(() => {})
          }
          if (options.inspectionFails) throw new Error('execution context unavailable')
          return {
            result: {
              value: control instanceof HTMLInputElement
                && (control.type === 'radio' || control.type === 'checkbox')
                ? {
                    kind: control.type,
                    checked: control.checked,
                    controlValue: control.value,
                  }
                : null,
            },
          }
        case 'Runtime.releaseObject':
          return {}
        case 'Input.dispatchMouseEvent':
          if (
            applyCheckableDefaultAction
            && params.type === 'mouseReleased'
            && params.button === 'left'
            && control instanceof HTMLInputElement
          ) {
            if (control.type === 'radio') control.checked = true
            if (control.type === 'checkbox') control.checked = !control.checked
          }
          return {}
        default:
          throw new Error(`unexpected CDP method: ${method}`)
      }
    }),
  } as any
}

describe('ActionRunner CDP 表单状态回执', () => {
  it('CDP click 后读取 radio 的真实选中态并投影为蛇形回执', async () => {
    document.body.innerHTML = '<input id="plan" type="radio" name="plan" value="pro">'

    const entry = await runSingleAction(
      makeCdpBackedCtx('#plan'),
      { type: 'click', selector: '#plan' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      control_value: 'pro',
      checked: true,
    })
  })

  it('原生控件状态读取绑定到实际点击的可见节点，而不是 selector 的首个隐藏匹配', async () => {
    document.body.innerHTML = `
      <input class="plan" type="radio" name="hidden-plan" value="hidden">
      <input class="plan" type="radio" name="visible-plan" value="large">
    `
    const controls = Array.from(document.querySelectorAll('.plan')) as HTMLInputElement[]
    const ctx = {
      isAlive: () => true,
      executeScript: vi.fn(async () => null),
      sendCDP: vi.fn(async (method: string, params: any) => {
        switch (method) {
          case 'DOM.enable':
          case 'Runtime.enable':
          case 'DOM.scrollIntoViewIfNeeded':
          case 'Runtime.releaseObject':
            return {}
          case 'DOM.getDocument':
            return { root: { nodeId: 1 } }
          case 'DOM.querySelectorAll':
            return { nodeIds: [11, 22] }
          case 'DOM.getBoxModel':
            if (params.nodeId === 11) throw new Error('hidden')
            return BOX
          case 'DOM.describeNode':
            return { node: { backendNodeId: 220 } }
          case 'DOM.resolveNode':
            return { object: { objectId: 'visible-control' } }
          case 'Runtime.callFunctionOn':
            return {
              result: {
                value: {
                  kind: 'radio',
                  checked: controls[1].checked,
                  controlValue: controls[1].value,
                },
              },
            }
          case 'Input.dispatchMouseEvent':
            if (params.type === 'mouseReleased') controls[1].checked = true
            return {}
          default:
            throw new Error(`unexpected CDP method: ${method}`)
        }
      }),
    } as any

    const entry = await runSingleAction(
      ctx,
      { type: 'click', selector: '.plan' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      control_value: 'large',
      checked: true,
    })
    expect(controls[0].checked).toBe(false)
    expect(ctx.executeScript).toHaveBeenCalled()
    expect(
      ctx.executeScript.mock.calls.every(([script]: [string]) => String(script).includes('__tabtinAgentCursor')),
    ).toBe(true)
  })

  it('CDP click 发出但 radio 未选中时返回失败，不再误报 success', async () => {
    document.body.innerHTML = '<input id="plan" type="radio" name="plan" value="pro">'

    const entry = await runSingleAction(
      makeCdpBackedCtx('#plan', { applyCheckableDefaultAction: false }),
      { type: 'click', selector: '#plan' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'failed',
      error_code: 'element_not_interactable',
      control_value: 'pro',
      checked: false,
    })
  })

  it('CDP click 发出但 checkbox 状态未切换时返回失败', async () => {
    document.body.innerHTML = '<input id="addon" type="checkbox" name="addon" value="bacon">'

    const entry = await runSingleAction(
      makeCdpBackedCtx('#addon', { applyCheckableDefaultAction: false }),
      { type: 'click', selector: '#addon' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'failed',
      error_code: 'element_not_interactable',
      control_value: 'bacon',
      checked: false,
    })
  })

  it('已勾选 checkbox 点击后取消勾选也视为有效切换', async () => {
    document.body.innerHTML = '<input id="addon" type="checkbox" name="addon" value="bacon" checked>'

    const entry = await runSingleAction(
      makeCdpBackedCtx('#addon'),
      { type: 'click', selector: '#addon' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      control_value: 'bacon',
      checked: false,
    })
  })

  it('已选中的 radio 再次点击仍以最终 checked=true 判定成功', async () => {
    document.body.innerHTML = '<input id="plan" type="radio" name="plan" value="pro" checked>'

    const entry = await runSingleAction(
      makeCdpBackedCtx('#plan'),
      { type: 'click', selector: '#plan' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      control_value: 'pro',
      checked: true,
    })
  })

  it('点击前无法检查目标节点时返回失败，不把未知控件误当普通按钮放行', async () => {
    document.body.innerHTML = '<input id="plan" type="radio" name="plan" value="pro">'

    const entry = await runSingleAction(
      makeCdpBackedCtx('#plan', { inspectionFails: true }),
      { type: 'click', selector: '#plan' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'failed',
      error_code: 'element_not_interactable',
    })
  })

  it('checkable 点击后页面上下文不再返回时，在短超时内给出可诊断失败', async () => {
    vi.useFakeTimers()
    try {
      document.body.innerHTML = '<input id="plan" type="radio" name="plan" value="pro">'
      const pending = runSingleAction(
        makeCdpBackedCtx('#plan', { postInspectionHangs: true }),
        { type: 'click', selector: '#plan' },
        1000,
      )

      await vi.advanceTimersByTimeAsync(1500)

      await expect(pending).resolves.toMatchObject({
        status: 'failed',
        error_code: 'element_not_interactable',
        control_value: 'pro',
        checked: false,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('selector 与显式坐标不能混用，避免点击目标与验收目标不一致', async () => {
    document.body.innerHTML = '<input id="plan" type="radio" name="plan" value="pro">'
    const ctx = makeCdpBackedCtx('#plan')

    const entry = await runSingleAction(
      ctx,
      { type: 'click', selector: '#plan', x: 100, y: 200 },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'failed',
      error_code: 'invalid_parameter',
    })
    expect(ctx.sendCDP).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    )
  })

  it('普通按钮在 click 触发导航后不再执行页面状态回读', async () => {
    document.body.innerHTML = '<button id="submit">Submit order</button>'
    let navigationStarted = false
    const ctx = makeCdpBackedCtx('#submit')
    ctx.executeScript = vi.fn(async (script: string) => {
      if (navigationStarted) return await new Promise(() => {})
      // 指针注入在 click 前；不要 eval 页内 rAF 动画，否则 50ms hung-race 会被拖死
      if (String(script).includes('__tabtinAgentCursor')) return
      // eslint-disable-next-line no-eval
      return eval(script)
    })
    const originalSendCDP = ctx.sendCDP
    ctx.sendCDP = vi.fn(async (method: string, params: any) => {
      const result = await originalSendCDP(method, params)
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        navigationStarted = true
      }
      return result
    })

    const outcome = await Promise.race([
      runSingleAction(ctx, { type: 'click', selector: '#submit' }, 1000),
      new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 50)),
    ])

    expect(outcome).not.toBe('hung')
    expect(outcome).toMatchObject({ status: 'success' })
    expect(ctx.executeScript).toHaveBeenCalled()
    const scripts = ctx.executeScript.mock.calls.map(([script]: [string]) => String(script))
    expect(scripts.some((s: string) => s.includes('__tabtinAgentCursorMoveTo'))).toBe(true)
  })

  it('CDP 句柄不可用但 JS 已解析坐标时仍点击普通元素', async () => {
    const mouseEvents: Array<{ type: string; x: number; y: number }> = []
    const ctx = {
      isAlive: () => true,
      executeScript: vi.fn(async () => ({
        ok: true,
        cx: 120,
        cy: 640,
        w: 30,
        h: 24,
      })),
      sendCDP: vi.fn(async (method: string, params: any) => {
        switch (method) {
          case 'DOM.enable':
          case 'Runtime.enable':
          case 'DOM.scrollIntoViewIfNeeded':
            return {}
          case 'DOM.getDocument':
            return { root: { nodeId: 1 } }
          case 'DOM.querySelectorAll':
            return { nodeIds: [215] }
          case 'DOM.getBoxModel':
            throw new Error('Could not compute box model')
          case 'Input.dispatchMouseEvent':
            mouseEvents.push(params)
            return {}
          default:
            throw new Error(`unexpected CDP method: ${method}`)
        }
      }),
    } as any

    const entry = await runSingleAction(
      ctx,
      { type: 'click', selector: '#js-coordinate-fallback' },
      1000,
    )

    expect(entry).toMatchObject({ status: 'success' })
    expect(mouseEvents).toEqual([
      expect.objectContaining({ type: 'mouseMoved', x: 120, y: 640 }),
      expect.objectContaining({ type: 'mousePressed', x: 120, y: 640 }),
      expect.objectContaining({ type: 'mouseReleased', x: 120, y: 640 }),
    ])
  })

  it('CDP select 后读取实际写入值并投影为蛇形回执', async () => {
    document.body.innerHTML = '<select id="tier"><option value="basic">Basic</option><option value="pro">Pro</option></select>'

    const entry = await runSingleAction(
      makeCdpBackedCtx('#tier'),
      { type: 'select', selector: '#tier', value: 'pro' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      actual_value: 'pro',
      control_value: 'pro',
    })
  })

  it('CDP select 写入不存在的值时返回实际值和 invalid_parameter', async () => {
    document.body.innerHTML = '<select id="tier"><option value="basic">Basic</option></select>'

    const entry = await runSingleAction(
      makeCdpBackedCtx('#tier'),
      { type: 'select', selector: '#tier', value: 'pro' },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'failed',
      error_code: 'invalid_parameter',
      actual_value: '',
      control_value: '',
    })
  })

  it('CDP type 事件发出但 value 未变时返回失败，避免假阳性', async () => {
    document.body.innerHTML = '<input id="name" type="text" placeholder="请输入姓名">'

    const entry = await runSingleAction(
      makeCdpTypeCtx('#name', { applyTypeDefaultAction: false }),
      { type: 'type', selector: '#name', value: '张三', delay: 0 },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'failed',
      error_code: 'invalid_parameter',
      actual_value: '',
    })
    expect((document.querySelector('#name') as HTMLInputElement).value).toBe('')
  })

  it('CDP type 成功后回读 actual_value；非 ASCII 走 insertText', async () => {
    document.body.innerHTML = '<input id="name" type="text">'
    const ctx = makeCdpTypeCtx('#name')

    const entry = await runSingleAction(
      ctx,
      { type: 'type', selector: '#name', value: '张三', delay: 0 },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      actual_value: '张三',
    })
    expect((document.querySelector('#name') as HTMLInputElement).value).toBe('张三')
    expect(ctx.sendCDP).toHaveBeenCalledWith(
      'Input.insertText',
      expect.objectContaining({ text: '张' }),
    )
    expect(ctx.sendCDP).toHaveBeenCalledWith(
      'Input.insertText',
      expect.objectContaining({ text: '三' }),
    )
  })

  it('CDP type ASCII 成功后回读 actual_value', async () => {
    document.body.innerHTML = '<input id="email" type="email">'

    const entry = await runSingleAction(
      makeCdpTypeCtx('#email'),
      { type: 'type', selector: '#email', value: 'test@example.com', delay: 0 },
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      actual_value: 'test@example.com',
    })
    expect((document.querySelector('#email') as HTMLInputElement).value).toBe('test@example.com')
  })

  it('normalizeActRequest 将 type.text 归一为 value 后可写入（ 复现载荷）', async () => {
    const { normalizeActRequest } = await import('../../orchestration/act-request')
    document.body.innerHTML = '<input id="name" type="text">'

    const normalized = normalizeActRequest({
      actions: [{ type: 'type', selector: '#name', text: '张三', delay: 0 }],
    })
    expect(normalized).toMatchObject({ ok: true })
    if (!normalized.ok) throw new Error('expected normalize ok')
    const action = (normalized.body.actions as Array<Record<string, unknown>>)[0]

    const entry = await runSingleAction(
      makeCdpTypeCtx('#name'),
      action as any,
      1000,
    )

    expect(entry).toMatchObject({
      status: 'success',
      actual_value: '张三',
    })
    expect(normalized.compatibilityWarnings).toEqual([
      expect.objectContaining({ code: 'TYPE_TEXT_ALIAS' }),
    ])
  })
})

/**
 * type 专用夹具：可选模拟「键盘事件已发出但 DOM value 不变」的假阳性。
 */
function makeCdpTypeCtx(
  selector: string,
  options: { applyTypeDefaultAction?: boolean } = {},
) {
  const control = document.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement
  if (!control || !('value' in control)) throw new Error(`missing editable ${selector}`)
  const applyTypeDefaultAction = options.applyTypeDefaultAction ?? true

  const appendText = (text: string) => {
    if (!applyTypeDefaultAction || !text) return
    control.value = `${control.value}${text}`
    control.dispatchEvent(new Event('input', { bubbles: true }))
  }

  return {
    isAlive: () => true,
    executeScript: vi.fn(async (script: string) => {
      // eslint-disable-next-line no-eval
      return eval(script)
    }),
    sendCDP: vi.fn(async (method: string, params: any) => {
      switch (method) {
        case 'DOM.enable':
        case 'Runtime.enable':
        case 'DOM.scrollIntoViewIfNeeded':
        case 'Runtime.releaseObject':
          return {}
        case 'DOM.getDocument':
          return { root: { nodeId: 1 } }
        case 'DOM.querySelectorAll':
          return { nodeIds: [1] }
        case 'DOM.getBoxModel':
          return BOX
        case 'DOM.describeNode':
          return { node: { backendNodeId: 1 } }
        case 'DOM.resolveNode':
          return { object: { objectId: 'control-1' } }
        case 'Input.dispatchMouseEvent':
          if (params.type === 'mouseReleased' && typeof control.focus === 'function') {
            control.focus()
          }
          return {}
        case 'Input.dispatchKeyEvent':
          if (params.type === 'keyDown' && typeof params.text === 'string') {
            appendText(params.text)
          }
          return {}
        case 'Input.insertText':
          appendText(params?.text ?? '')
          return {}
        default:
          throw new Error(`unexpected CDP method: ${method}`)
      }
    }),
  } as any
}
