import { describe, expect, it, vi } from 'vitest'
import { PtyWriteChannel } from '../PtyWriteChannel'

describe('PtyWriteChannel', () => {
  it('按顺序 flush 所有写入，并在 flush 后清空排队字节数', () => {
    const writes: string[] = []
    const channel = new PtyWriteChannel({
      write: (chunk: string) => {
        writes.push(chunk)
      },
    })

    expect(channel.enqueue('echo 1\n')).toBe(true)
    expect(channel.enqueue('echo 2\n')).toBe(true)

    expect(writes).toEqual(['echo 1\n', 'echo 2\n'])
    expect(channel.getQueuedBytes()).toBe(0)
    expect(channel.isClosed()).toBe(false)
  })

  it('在底层 write 抛错时关闭通道并通过回调暴露错误', () => {
    const onWriteError = vi.fn()
    const channel = new PtyWriteChannel(
      {
        write: () => {
          throw new Error('boom')
        },
      },
      { onWriteError },
    )

    expect(channel.enqueue('echo fail\n')).toBe(false)
    expect(channel.isClosed()).toBe(true)
    expect(channel.getQueuedBytes()).toBe(0)
    expect(onWriteError).toHaveBeenCalledTimes(1)
    expect(onWriteError.mock.calls[0]?.[1]).toBe('echo fail\n')
  })

  it('在 close 或超过排队上限后拒绝新的写入', () => {
    const onWriteError = vi.fn()
    const channel = new PtyWriteChannel(
      {
        write: vi.fn(),
      },
      {
        maxQueuedBytes: 2,
        onWriteError,
      },
    )

    expect(channel.enqueue('abc')).toBe(false)
    expect(channel.isClosed()).toBe(true)
    expect(onWriteError).toHaveBeenCalledTimes(1)

    channel.close()
    expect(channel.enqueue('x')).toBe(false)
  })
})
