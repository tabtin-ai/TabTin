import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useChatInputFileHandlers } from '../useChatInputClearState'

describe('useChatInputFileHandlers', () => {
  it('打开文件选择器不依赖模型目录或其他异步准备', () => {
    const click = vi.fn()
    const fileInputRef = { current: { click } as HTMLInputElement }
    const { result } = renderHook(() => useChatInputFileHandlers(
      fileInputRef,
      vi.fn(),
    ))

    act(() => result.current.handleFileSelect())

    expect(click).toHaveBeenCalledOnce()
  })
})
