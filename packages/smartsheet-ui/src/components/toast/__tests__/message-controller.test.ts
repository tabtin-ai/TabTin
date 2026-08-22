import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageController } from '../message-controller'
import {
  installMessageTransport,
  message,
  getMessageController,
} from '../message-api'

describe('MessageController', () => {
  let controller: MessageController

  beforeEach(() => {
    vi.useFakeTimers()
    controller = new MessageController()
  })

  afterEach(() => {
    controller.reset()
    vi.useRealTimers()
  })

  it('success 默认 2s 后自动 destroy', () => {
    const item = controller.open({ type: 'success', content: 'ok' })
    expect(controller.getVisibleItems()).toHaveLength(1)

    vi.advanceTimersByTime(1999)
    expect(controller.getVisibleItems().some((x) => x.key === item.key)).toBe(true)

    vi.advanceTimersByTime(2)
    expect(controller.getVisibleItems().some((x) => x.key === item.key && x.open)).toBe(false)
  })

  it('error 默认 2s；duration 0 常驻', () => {
    const transient = controller.open({ type: 'error', content: 'fail' })
    const sticky = controller.open({ type: 'error', content: 'fail', duration: 0 })

    vi.advanceTimersByTime(1_999)
    expect(controller.getVisibleItems().find((x) => x.key === transient.key)?.open).toBe(true)

    vi.advanceTimersByTime(2)
    expect(controller.getVisibleItems().find((x) => x.key === transient.key)).toBeUndefined()
    expect(controller.getVisibleItems().find((x) => x.key === sticky.key)?.open).toBe(true)

    controller.destroy(sticky.key)
    expect(controller.getVisibleItems().find((x) => x.key === sticky.key)).toBeUndefined()
  })

  it('同 key 更新而不堆叠', () => {
    controller.open({ key: 'k1', type: 'info', content: 'a' })
    controller.open({ key: 'k1', type: 'success', content: 'b' })
    const visible = controller.getVisibleItems()
    expect(visible).toHaveLength(1)
    expect(visible[0]?.content).toBe('b')
    expect(visible[0]?.type).toBe('success')
  })

  it('loading → update success 会重算 duration', () => {
    const item = controller.open({ type: 'loading', content: '…', duration: 0 })
    controller.update({ key: item.key, type: 'success', content: 'done' })
    expect(controller.getVisibleItems()[0]?.type).toBe('success')

    vi.advanceTimersByTime(2001)
    expect(controller.getVisibleItems().find((x) => x.key === item.key)?.open).not.toBe(true)
  })

  it('destroy() 无 key 关闭全部', () => {
    controller.open({ type: 'info', content: '1' })
    controller.open({ type: 'info', content: '2' })
    controller.destroy()
    expect(controller.getVisibleItems()).toHaveLength(0)
  })
})

describe('message API', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getMessageController().reset()
    installMessageTransport(null)
  })

  afterEach(() => {
    getMessageController().reset()
    installMessageTransport(null)
    vi.useRealTimers()
  })

  it('shorthand 与 open 对象形态都能工作', () => {
    message.success('saved')
    message.error({ content: 'failed', description: 'disk full' })
    const visible = getMessageController().getVisibleItems()
    expect(visible).toHaveLength(2)
    expect(visible[0]?.type).toBe('error')
    expect(visible[1]?.type).toBe('success')
  })

  it('loading handle 可 update / destroy', () => {
    const pending = message.loading('working')
    expect(getMessageController().getVisibleItems()[0]?.type).toBe('loading')

    pending.update({ type: 'success', content: 'done' })
    expect(getMessageController().getVisibleItems()[0]?.content).toBe('done')

    pending.destroy()
    expect(getMessageController().getVisibleItems()).toHaveLength(0)
  })
})
