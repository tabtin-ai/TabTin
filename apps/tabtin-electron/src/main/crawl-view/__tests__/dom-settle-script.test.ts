import { describe, it, expect, afterEach } from 'vitest'
import { buildDomSettleScript } from '../content-ops'

// 在 jsdom 下执行与生产同一份注入脚本，验证 DOM 稳定/持续变化两种判定。
function runSettleScript(quietMs: number, maxWaitMs: number): Promise<boolean> {
  // 脚本是自执行 IIFE 表达式，eval 直接返回其 Promise。
  return eval(buildDomSettleScript(quietMs, maxWaitMs)) as Promise<boolean>
}

describe('buildDomSettleScript', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('DOM 不再变化时判定 settled（true）', async () => {
    const promise = runSettleScript(50, 1000)
    // 触发一次变更后停止，安静窗口内应判定稳定
    document.body.appendChild(document.createElement('div'))
    await expect(promise).resolves.toBe(true)
  })

  it('DOM 持续变化超过上限时判定 unsettled（false）', async () => {
    const promise = runSettleScript(50, 200)
    // 每 20ms 变更一次（< 安静窗口 50ms），持续到超过 maxWait
    const timer = setInterval(() => {
      document.body.appendChild(document.createElement('span'))
    }, 20)
    const result = await promise
    clearInterval(timer)
    expect(result).toBe(false)
  })

  it('无任何变更也会在安静窗口后 settled', async () => {
    await expect(runSettleScript(50, 1000)).resolves.toBe(true)
  })
})
