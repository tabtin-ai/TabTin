import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { emitContextInject, useContextInjection } from '../useContextInjection'
import { useContextInjectionStore } from '@/stores/useContextInjectionStore'

describe('useContextInjection', () => {
  beforeEach(() => {
    useContextInjectionStore.setState({
      activeScopeId: null,
      contextRefsByScopeId: {},
    })
  })

  it('会把外部注入的引用落到当前激活的 scope', () => {
    const { result } = renderHook(() => useContextInjection('session-a', true))

    act(() => {
      emitContextInject({
        type: 'web_selection',
        resourceId: 'https://tabtin.ai/docs',
        label: 'TabTin 文档',
        preview: '这里是一段网页引用',
        meta: {
          url: 'https://tabtin.ai/docs',
          pageTitle: 'TabTin 文档',
        },
      })
    })

    expect(result.current.contextRefs).toHaveLength(1)
    expect(result.current.contextRefs[0]).toMatchObject({
      type: 'web_selection',
      resourceId: 'https://tabtin.ai/docs',
      label: 'TabTin 文档',
      meta: expect.objectContaining({
        url: 'https://tabtin.ai/docs',
        pageTitle: 'TabTin 文档',
        preview: '这里是一段网页引用',
      }),
    })
    expect(result.current.toBlocks()).toEqual([
      {
        type: 'web_selection',
        preview: '这里是一段网页引用',
        url: 'https://tabtin.ai/docs',
        page_title: 'TabTin 文档',
      },
    ])
  })

  it('会把网页注释转换成 web_annotation block', () => {
    const { result } = renderHook(() => useContextInjection('session-a', true))

    act(() => {
      emitContextInject({
        type: 'web_annotation',
        resourceId: 'https://tabtin.ai/docs',
        label: 'TabTin 文档',
        preview: '选中的网页文字',
        tabType: 'tabweb',
        meta: {
          url: 'https://tabtin.ai/docs',
          pageTitle: 'TabTin 文档',
          selection: { kind: 'text', text: '选中的网页文字' },
          rect: { x: 10, y: 20, width: 100, height: 32 },
          dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
          screenshotAttachmentId: 'browser-annotation-1',
          screenshotFilename: 'browser-annotation-1.png',
        },
      })
    })

    expect(result.current.toBlocks()).toEqual([
      {
        type: 'web_annotation',
        preview: '选中的网页文字',
        tab_type: 'tabweb',
        url: 'https://tabtin.ai/docs',
        page_title: 'TabTin 文档',
        selection: { kind: 'text', text: '选中的网页文字' },
        rect: { x: 10, y: 20, width: 100, height: 32 },
        dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
        screenshot_attachment_id: 'browser-annotation-1',
        screenshot_filename: 'browser-annotation-1.png',
      },
    ])
  })

  it('同一个 DOM 的网页注释会保持唯一并更新原 chip', () => {
    const { result } = renderHook(() => useContextInjection('session-a', true))

    act(() => {
      emitContextInject({
        type: 'web_annotation',
        resourceId: 'https://tabtin.ai/docs',
        label: 'TabTin 文档',
        preview: '第一次',
        tabType: 'tabweb',
        meta: {
          url: 'https://tabtin.ai/docs',
          pageTitle: 'TabTin 文档',
          annotationId: 'ann-old',
          selection: { kind: 'element', text: '按钮' },
          rect: { x: 10, y: 20, width: 100, height: 32 },
          dom: { tag: 'button', selector: 'button:nth-of-type(1)' },
        },
      })
      emitContextInject({
        type: 'web_annotation',
        resourceId: 'https://tabtin.ai/docs',
        label: 'TabTin 文档',
        preview: '第二次',
        tabType: 'tabweb',
        meta: {
          url: 'https://tabtin.ai/docs',
          pageTitle: 'TabTin 文档',
          annotationId: 'ann-new',
          selection: { kind: 'element', text: '按钮' },
          rect: { x: 11, y: 21, width: 100, height: 32 },
          dom: { tag: 'button', selector: 'button:nth-of-type(1)' },
          screenshotFilename: 'browser-annotation-ann-new.png',
        },
      })
    })

    expect(result.current.contextRefs).toHaveLength(1)
    expect(result.current.contextRefs[0].id).toBeDefined()
    expect(result.current.contextRefs[0].meta).toMatchObject({
      preview: '第二次',
      annotationId: 'ann-new',
      screenshotFilename: 'browser-annotation-ann-new.png',
    })
  })

  it('同一页面的不同 DOM 网页注释可以并存', () => {
    const { result } = renderHook(() => useContextInjection('session-a', true))

    act(() => {
      emitContextInject({
        type: 'web_annotation',
        resourceId: 'https://tabtin.ai/docs',
        label: 'TabTin 文档',
        preview: '按钮',
        meta: {
          url: 'https://tabtin.ai/docs',
          selection: { kind: 'element', text: '按钮' },
          dom: { tag: 'button', selector: 'button:nth-of-type(1)' },
        },
      })
      emitContextInject({
        type: 'web_annotation',
        resourceId: 'https://tabtin.ai/docs',
        label: 'TabTin 文档',
        preview: '输入框',
        meta: {
          url: 'https://tabtin.ai/docs',
          selection: { kind: 'element', text: '输入框' },
          dom: { tag: 'input', selector: 'input:nth-of-type(1)' },
        },
      })
    })

    expect(result.current.contextRefs).toHaveLength(2)
  })

  it('同一 DOM 内相同文本但不同区域的网页文字注释可以并存', () => {
    const { result } = renderHook(() => useContextInjection('session-a', true))

    act(() => {
      emitContextInject({
        type: 'web_annotation',
        resourceId: 'https://tabtin.ai/docs',
        label: 'TabTin 文档',
        preview: '重复文字',
        meta: {
          url: 'https://tabtin.ai/docs',
          selection: { kind: 'text', text: '重复文字' },
          rect: { x: 10, y: 20, width: 80, height: 20 },
          dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
        },
      })
      emitContextInject({
        type: 'web_annotation',
        resourceId: 'https://tabtin.ai/docs',
        label: 'TabTin 文档',
        preview: '重复文字',
        meta: {
          url: 'https://tabtin.ai/docs',
          selection: { kind: 'text', text: '重复文字' },
          rect: { x: 10, y: 80, width: 80, height: 20 },
          dom: { tag: 'p', selector: 'p:nth-of-type(1)' },
        },
      })
    })

    expect(result.current.contextRefs).toHaveLength(2)
  })

  it('切换激活 scope 后，新的注入会进入新的输入目标', async () => {
    const first = renderHook(
      ({ enabled }) => useContextInjection('session-a', enabled),
      { initialProps: { enabled: true } },
    )
    const second = renderHook(
      ({ enabled }) => useContextInjection('session-b', enabled),
      { initialProps: { enabled: false } },
    )

    act(() => {
      emitContextInject({
        type: 'code_file',
        resourceId: '/tmp/a.ts',
        label: 'a.ts',
        preview: 'console.log("a")',
        meta: {
          filePath: '/tmp/a.ts',
          rootPath: '/tmp',
        },
      })
    })

    expect(first.result.current.contextRefs).toHaveLength(1)
    expect(second.result.current.contextRefs).toHaveLength(0)

    act(() => {
      first.rerender({ enabled: false })
      second.rerender({ enabled: true })
    })

    await waitFor(() => {
      expect(useContextInjectionStore.getState().activeScopeId).toBe('session-b')
    })

    act(() => {
      emitContextInject({
        type: 'code_file',
        resourceId: '/tmp/b.ts',
        label: 'b.ts',
        preview: 'console.log("b")',
        meta: {
          filePath: '/tmp/b.ts',
          rootPath: '/tmp',
        },
      })
    })

    expect(first.result.current.contextRefs).toHaveLength(1)
    expect(second.result.current.contextRefs).toHaveLength(1)
    expect(second.result.current.contextRefs[0]).toMatchObject({
      resourceId: '/tmp/b.ts',
      label: 'b.ts',
    })
  })

  it('同一资源的不同选区不会被错误去重', () => {
    const { result } = renderHook(() => useContextInjection('session-a', true))

    act(() => {
      emitContextInject({
        type: 'doc_selection',
        resourceId: 'doc-1',
        label: '产品说明',
        preview: '第一段',
        meta: {
          block_ids: ['block-1'],
          full_text: '第一段',
        },
      })
      emitContextInject({
        type: 'doc_selection',
        resourceId: 'doc-1',
        label: '产品说明',
        preview: '第二段',
        meta: {
          block_ids: ['block-2'],
          full_text: '第二段',
        },
      })
    })

    expect(result.current.contextRefs).toHaveLength(2)
    expect(result.current.toBlocks()).toEqual([
      {
        type: 'doc_selection',
        doc_id: 'doc-1',
        block_ids: ['block-1'],
        full_text: '第一段',
        preview: '第一段',
      },
      {
        type: 'doc_selection',
        doc_id: 'doc-1',
        block_ids: ['block-2'],
        full_text: '第二段',
        preview: '第二段',
      },
    ])
  })

  it('整篇文档引用保持 document 类型，发送时由后端读取正文', () => {
    const { result } = renderHook(() => useContextInjection('session-a', true))

    act(() => {
      result.current.addContextRef('document', 'doc-1', '产品说明', {
        spaceId: 'space-1',
        tabType: 'tabdoc',
        meta: { preview: '产品说明\n交付结论：已完成初稿' },
      })
    })

    expect(result.current.toBlocks()).toEqual([{
      type: 'document',
      doc_id: 'doc-1',
      preview: '产品说明\n交付结论：已完成初稿',
      space_id: 'space-1',
      tab_type: 'tabdoc',
    }])
  })
})
