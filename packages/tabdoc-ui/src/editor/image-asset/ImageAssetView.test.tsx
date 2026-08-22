/** @vitest-environment jsdom */

import React, { forwardRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & { as?: string }>(
    ({ as: Tag = 'div', children, ...props }, ref) => React.createElement(Tag, { ...props, ref }, children),
  ),
}))

import { ImageAssetPreviewProvider } from './ImageAssetLoaderContext'
import { ImageAssetView } from './ImageAssetView'

afterEach(cleanup)

describe('ImageAssetView resize controls', () => {
  it('第一次点击只选中图片，再次点击已选中的图片才打开预览', () => {
    const preview = vi.fn()
    const setNodeSelection = vi.fn()
    const props = {
      node: { attrs: { src: 'https://example.com/diagram.png', alt: 'diagram.png', fileId: 'file-1' } },
      selected: false,
      updateAttributes: vi.fn(),
      editor: { commands: { setNodeSelection } },
      getPos: () => 12,
    } as never
    const { rerender } = render(
      <ImageAssetPreviewProvider value={preview}>
        <ImageAssetView {...props} />
      </ImageAssetPreviewProvider>,
    )

    fireEvent.pointerDown(screen.getByRole('img', { name: 'diagram.png' }))
    expect(setNodeSelection).toHaveBeenCalledWith(12)

    rerender(
      <ImageAssetPreviewProvider value={preview}>
        <ImageAssetView {...({ ...props, selected: true } as never)} />
      </ImageAssetPreviewProvider>,
    )
    fireEvent.click(screen.getByRole('img', { name: 'diagram.png' }))
    expect(preview).not.toHaveBeenCalled()

    fireEvent.pointerDown(screen.getByRole('img', { name: 'diagram.png' }))
    fireEvent.click(screen.getByRole('img', { name: 'diagram.png' }))

    expect(preview).toHaveBeenCalledOnce()
    expect(preview).toHaveBeenCalledWith({
      url: 'https://example.com/diagram.png',
      fileId: 'file-1',
      name: 'diagram.png',
    })
  })

  it('图片本体可作为 ProseMirror 拖拽手柄', () => {
    render(
      <ImageAssetView
        {...({
          node: { attrs: { src: 'https://example.com/diagram.png', alt: 'diagram.png' } },
          selected: false,
          updateAttributes: vi.fn(),
        } as never)}
      />,
    )

    const image = screen.getByRole('img', { name: 'diagram.png' })
    expect(image.draggable).toBe(true)
    expect(image.hasAttribute('data-drag-handle')).toBe(true)
  })

  it('缩放手柄固定在左右边界的垂直中线', () => {
    render(
      <div className="ProseMirror">
        <ImageAssetView
          {...({
            node: { attrs: { src: 'https://example.com/diagram.png' } },
            selected: true,
            updateAttributes: vi.fn(),
          } as never)}
        />
      </div>,
    )

    const left = screen.getByRole('slider', { name: '从左侧调整图片宽度' })
    const right = screen.getByRole('slider', { name: '从右侧调整图片宽度' })
    expect(left.style.top).toBe('50%')
    expect(left.style.transform).toBe('translateY(-50%)')
    expect(left.style.left).toBe('calc(-0.75rem - 3px)')
    expect(right.style.right).toBe('calc(-0.75rem - 3px)')
  })

  it('在图片左右边界中线展示两个可访问的缩放手柄', () => {
    render(
      <ImageAssetView
        {...({
          node: { attrs: { src: 'https://example.com/diagram.png', alt: 'diagram.png' } },
          selected: true,
          updateAttributes: vi.fn(),
        } as never)}
      />,
    )

    expect(screen.getByRole('img', { name: 'diagram.png' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: '从左侧调整图片宽度' }).dataset.resizeSide).toBe('left')
    expect(screen.getByRole('slider', { name: '从右侧调整图片宽度' }).dataset.resizeSide).toBe('right')
  })

  it('拖动右侧手柄后只持久化宽度并保持图片比例', () => {
    const updateAttributes = vi.fn()
    render(
      <ImageAssetView
        {...({
          node: { attrs: { src: 'https://example.com/diagram.png', alt: 'diagram.png', width: 320 } },
          selected: true,
          updateAttributes,
        } as never)}
      />,
    )
    const image = screen.getByRole('img', { name: 'diagram.png' })
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect)
    const handle = screen.getByRole('slider', { name: '从右侧调整图片宽度' })

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 180 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 180 })

    expect(updateAttributes).toHaveBeenLastCalledWith({ width: 400, height: null })
  })

  it('在 TipTap React NodeView 包装层存在时仍允许图片放大到段落宽度', () => {
    const updateAttributes = vi.fn()
    render(
      <div className="ProseMirror">
        <p>
          <span className="react-renderer node-image">
            <ImageAssetView
              {...({
                node: { attrs: { src: 'https://example.com/diagram.png', alt: 'diagram.png', width: 320 } },
                selected: true,
                updateAttributes,
              } as never)}
            />
          </span>
        </p>
      </div>,
    )
    const image = screen.getByRole('img', { name: 'diagram.png' })
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect)
    const paragraph = image.closest('p')
    expect(paragraph).not.toBeNull()
    vi.spyOn(paragraph!, 'getBoundingClientRect').mockReturnValue({ width: 640 } as DOMRect)
    const renderer = image.closest('.react-renderer')
    expect(renderer).not.toBeNull()
    vi.spyOn(renderer!, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect)
    const handle = screen.getAllByRole('slider')[1]

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 180 })
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 180 })

    expect(updateAttributes).toHaveBeenLastCalledWith({ width: 400, height: null })
  })
})
