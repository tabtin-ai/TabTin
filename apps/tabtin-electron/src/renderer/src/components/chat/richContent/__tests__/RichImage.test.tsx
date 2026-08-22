import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RichContentBlock } from '@tabtin/chat-client'
import { RichImage } from '../RichImage'

const useFileIdImageUrl = vi.fn(() => ({
  data: null as { url: string; name?: string } | null,
  loading: false,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/utils/fileRefDrag', () => ({
  useChatImageDragSource: () => ({
    draggable: false,
    onDragStart: undefined,
  }),
}))

vi.mock('../../blocks/useFileIdImageUrl', () => ({
  useFileIdImageUrl: (fileId: string | null) => useFileIdImageUrl(fileId),
}))

describe('RichImage', () => {
  it('按原图比例缩小，卡片容器贴合图片而不横向拉伸', () => {
    render(
      <RichImage
        block={{
          type: 'rich_content',
          kind: 'image',
          url: 'https://example.test/square.png',
          summary: '方形图片',
        } as RichContentBlock}
      />,
    )

    const image = screen.getByRole('img', { name: '方形图片' })
    fireEvent.load(image)
    const button = image.closest('button')

    expect(button).toBeTruthy()
    expect(button!.className).toContain('self-start')
    expect(button!.className).toContain('inline-flex')
    expect(image.className).toContain('object-contain')
    expect(image.className).toContain('h-auto')
    expect(image.className).toContain('w-auto')
  })

  it('loading 用柔和占位，无 Loader2 spinner', () => {
    render(
      <RichImage
        block={{
          type: 'rich_content',
          kind: 'image',
          url: 'https://example.test/loading.png',
          summary: '加载中图',
        } as RichContentBlock}
      />,
    )

    expect(screen.getByTestId('rich-image-loading-placeholder')).toBeTruthy()
    expect(screen.queryByTestId('rich-image-spinner')).toBeNull()
    // 无 lucide Loader2 的 animate-spin 节点
    expect(document.querySelector('.animate-spin')).toBeNull()

    const image = screen.getByRole('img', { name: '加载中图' })
    expect(image.className).toContain('opacity-0')
    expect(image.className).not.toContain('sr-only')
  })

  it('onload 后 img 可见（opacity-100）并去掉 loading 占位', () => {
    render(
      <RichImage
        block={{
          type: 'rich_content',
          kind: 'image',
          url: 'https://example.test/ready.png',
          summary: '就绪图',
        } as RichContentBlock}
      />,
    )

    const image = screen.getByRole('img', { name: '就绪图' })
    fireEvent.load(image)

    expect(image.className).toContain('opacity-100')
    expect(screen.queryByTestId('rich-image-loading-placeholder')).toBeNull()
  })

  it('永久 OSS 图片按 file_id 换取新地址，不把 tabtin 资源地址交给 img', () => {
    useFileIdImageUrl.mockReturnValueOnce({
      data: { url: 'https://oss.example.test/fresh.png', name: 'fresh.png' },
      loading: false,
    })

    render(
      <RichImage
        block={{
          type: 'rich_content',
          kind: 'image',
          artifact_kind: 'oss_file',
          file_id: 'file-123',
          url: 'tabtin://resource/file/file-123?hint=tabfiles',
          access_url: 'https://oss.example.test/expired.png',
          summary: '永久图片',
        } as RichContentBlock}
      />,
    )

    expect(useFileIdImageUrl).toHaveBeenCalledWith('file-123')
    expect(screen.getByRole('img', { name: '永久图片' }).getAttribute('src'))
      .toBe('https://oss.example.test/fresh.png')
  })
})
