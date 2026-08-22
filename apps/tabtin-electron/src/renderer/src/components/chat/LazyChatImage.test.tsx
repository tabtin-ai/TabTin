import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LazyChatImage } from './LazyChatImage'

const mediaState = vi.hoisted(() => ({
  current: {
    displaySrc: 'https://example.test/loading.png',
    resolving: false,
    failed: false,
  },
}))

vi.mock('./preview/useCachedChatMediaSrc', () => ({
  useCachedChatMediaSrc: () => mediaState.current,
}))

describe('LazyChatImage', () => {
  it('加载中显示柔和占位，img 保持 opacity-0', () => {
    mediaState.current = {
      displaySrc: 'https://example.test/loading.png',
      resolving: false,
      failed: false,
    }
    render(
      <LazyChatImage
        src="https://example.test/loading.png"
        alt="加载中"
        buttonAriaLabel="查看"
      />,
    )

    expect(screen.getByTestId('chat-image-loading-placeholder')).toBeTruthy()
    const img = screen.getByRole('img', { name: '加载中' })
    expect(img.className).toContain('opacity-0')
    expect(document.querySelector('.animate-spin')).toBeNull()
  })

  it('onload 后去掉占位并回调 onLoad', () => {
    mediaState.current = {
      displaySrc: 'https://example.test/ready.png',
      resolving: false,
      failed: false,
    }
    const onLoad = vi.fn()
    render(
      <LazyChatImage
        src="https://example.test/ready.png"
        alt="就绪"
        onLoad={onLoad}
      />,
    )

    fireEvent.load(screen.getByRole('img', { name: '就绪' }))
    expect(screen.queryByTestId('chat-image-loading-placeholder')).toBeNull()
    expect(onLoad).toHaveBeenCalledTimes(1)
  })

  it('onerror 回调 onError 并结束 loading', () => {
    mediaState.current = {
      displaySrc: 'https://example.test/broken.png',
      resolving: false,
      failed: false,
    }
    const onError = vi.fn()
    render(
      <LazyChatImage
        src="https://example.test/broken.png"
        alt="失败"
        onError={onError}
      />,
    )

    fireEvent.error(screen.getByRole('img', { name: '失败' }))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('chat-image-loading-placeholder')).toBeNull()
  })

  it('onload 后再 resolving 也不拆掉已有 img / 不重新撑占位', () => {
    mediaState.current = {
      displaySrc: 'https://example.test/a.png',
      resolving: false,
      failed: false,
    }
    const { rerender } = render(
      <LazyChatImage src="https://example.test/a.png" alt="稳态" />,
    )
    fireEvent.load(screen.getByRole('img', { name: '稳态' }))
    expect(screen.queryByTestId('chat-image-loading-placeholder')).toBeNull()

    mediaState.current = {
      displaySrc: 'blob:http://localhost/a',
      resolving: true,
      failed: false,
    }
    rerender(<LazyChatImage src="https://example.test/a.png" alt="稳态" />)

    expect(screen.getByRole('img', { name: '稳态' })).toBeTruthy()
    expect(screen.queryByTestId('chat-image-loading-placeholder')).toBeNull()
  })

  it('同步 blob 起步时不显示加载占位', () => {
    mediaState.current = {
      displaySrc: 'blob:http://localhost/cached',
      resolving: false,
      failed: false,
    }
    render(
      <LazyChatImage src="https://example.test/cached.png" alt="缓存命中" />,
    )
    expect(screen.queryByTestId('chat-image-loading-placeholder')).toBeNull()
    expect(screen.getByRole('img', { name: '缓存命中' }).className).toContain('opacity-100')
  })
})
