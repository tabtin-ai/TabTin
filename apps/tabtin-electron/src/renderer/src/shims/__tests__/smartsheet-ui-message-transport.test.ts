import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Message 一律本窗 Host：不桥 overlay，避免全屏透明层挡点击；关闭钮与自动消失走本窗。
 */
describe('Electron message local-host transport', () => {
  const push = vi.fn().mockResolvedValue({ success: true })

  beforeEach(() => {
    push.mockClear()
    vi.resetModules()
    ;(window as any).tabtin = { overlay: { push } }
    try {
      window.history.replaceState({}, '', '/index.html')
    } catch {
      /* ignore */
    }
  })

  afterEach(() => {
    delete (window as any).tabtin
  })

  it('纯文案 message.success 写入本窗 Host，不推 overlay', async () => {
    const mod = await import('../smartsheet-ui-toast')
    mod.reinstallElectronMessageTransport()
    mod.getMessageController().reset()

    const handle = mod.message.success('saved')
    expect(push).not.toHaveBeenCalled()
    expect(mod.getMessageController().getVisibleItems()).toHaveLength(1)
    expect(mod.getMessageController().getVisibleItems()[0]?.content).toBe('saved')

    handle.destroy()
    expect(mod.getMessageController().getVisibleItems()).toHaveLength(0)
    expect(push).not.toHaveBeenCalled()
    mod.getMessageController().reset()
  })

  it('loading → update 仍在本窗', async () => {
    const mod = await import('../smartsheet-ui-toast')
    mod.reinstallElectronMessageTransport()
    mod.getMessageController().reset()

    const handle = mod.message.loading('working')
    expect(push).not.toHaveBeenCalled()
    expect(mod.getMessageController().getVisibleItems()[0]?.type).toBe('loading')

    handle.update({ type: 'success', content: 'done' })
    const item = mod.getMessageController().getVisibleItems()[0]
    expect(item?.type).toBe('success')
    expect(item?.content).toBe('done')
    expect(push).not.toHaveBeenCalled()
    mod.getMessageController().reset()
  })

  it('带 action 的 message 也在本窗 Host', async () => {
    const mod = await import('../smartsheet-ui-toast')
    mod.reinstallElectronMessageTransport()
    mod.getMessageController().reset()

    const onClick = vi.fn()
    mod.message.success('with action', {
      action: { label: 'Undo', onClick },
    })
    expect(mod.getMessageController().getVisibleItems()).toHaveLength(1)
    expect(push).not.toHaveBeenCalled()
    mod.getMessageController().reset()
  })

  it('再导出 message 公开时长常量，避免打包 alias 漏导出', async () => {
    const mod = await import('../smartsheet-ui-toast')
    const native = await import('@tabtin/smartsheet-ui/message-native')
    expect(mod.MESSAGE_LIMIT).toBe(native.MESSAGE_LIMIT)
    expect(mod.MESSAGE_DEFAULT_DURATION).toBe(native.MESSAGE_DEFAULT_DURATION)
    expect(mod.MESSAGE_ERROR_DURATION).toBe(native.MESSAGE_ERROR_DURATION)
  })
})
