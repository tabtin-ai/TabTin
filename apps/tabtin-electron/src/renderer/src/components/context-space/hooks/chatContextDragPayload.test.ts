import { describe, expect, it, vi } from 'vitest'

import { DRAG_TYPE_CHAT_CONTEXT } from '@/utils/split-coordinator'
import type { SpaceContextItem } from '@/services/spaceApi'
import type { ContextItem, ContextRegistry } from '../registry'
import {
  buildFileTreeChatDragPayload,
  buildSpaceItemChatContextDragPayload,
  writeChatContextDragPayload,
  writeFileTreeChatDragData,
} from './chatContextDragPayload'
import { readChatContextDragPayload } from '@components/chat/composer/chatContextDrag'

const baseItem: SpaceContextItem = {
  id: 'context-item-1',
  item_type: 'document',
  title: '设计文档',
  preview: '',
  resource_id: 'doc-1',
  space_id: 'space-1',
  space_name: '产品空间',
  metadata: { source: 'list' },
  is_archived: false,
  updated_at: null,
  created_at: null,
}

function createRegistry(): ContextRegistry {
  return {
    normalizeBackendType: (backendType: string) => (backendType === 'document' ? 'tabdoc' : backendType),
    buildContextAttachment: (item: ContextItem) => ({
      refType: 'document',
      resourceId: item.id,
      label: item.title || '',
      meta: item.meta,
    }),
  } as unknown as ContextRegistry
}

describe('chatContextDragPayload', () => {
  it('从 Space 资源列表项构造聊天拖拽 payload 时使用 resource_id', () => {
    const payload = buildSpaceItemChatContextDragPayload(baseItem, createRegistry())

    expect(payload).toEqual({
      type: 'document',
      resourceId: 'doc-1',
      label: '设计文档',
      tabType: 'tabdoc',
      spaceId: 'space-1',
      spaceName: '产品空间',
      meta: { source: 'list' },
    })
  })

  it('resource_id 缺失时不退回 context item id', () => {
    const registry = createRegistry()
    const spy = vi.spyOn(registry, 'buildContextAttachment')

    const payload = buildSpaceItemChatContextDragPayload({
      ...baseItem,
      resource_id: '',
    }, registry)

    expect(payload).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('写入聊天上下文 MIME 和文本兜底', () => {
    const writes = new Map<string, string>()
    const ok = writeChatContextDragPayload({
      setData: (type: string, value: string) => writes.set(type, value),
    }, {
      type: 'document',
      resourceId: 'doc-1',
      label: '设计文档',
      tabType: 'tabdoc',
    })

    expect(ok).toBe(true)
    expect(JSON.parse(writes.get(DRAG_TYPE_CHAT_CONTEXT) || '{}')).toEqual({
      type: 'document',
      resourceId: 'doc-1',
      label: '设计文档',
      tabType: 'tabdoc',
    })
    expect(writes.get('text/plain')).toBe('设计文档')
  })
})

describe('buildFileTreeChatDragPayload（ 文件树拖入对话框）', () => {
  it('文件 → code_file，label 取文件名，meta 带 filePath / rootPath', () => {
    const payload = buildFileTreeChatDragPayload(
      { path: '/Users/me/proj/src/index.ts', isDirectory: false },
      { rootPath: '/Users/me/proj' },
    )
    expect(payload).toEqual({
      type: 'code_file',
      resourceId: '/Users/me/proj/src/index.ts',
      label: 'index.ts',
      meta: { filePath: '/Users/me/proj/src/index.ts', rootPath: '/Users/me/proj' },
    })
  })

  it('目录 → folder，不写 filePath/rootPath（folder 用 resourceId 即 folder_path）', () => {
    const payload = buildFileTreeChatDragPayload(
      { path: '/Users/me/proj/src', isDirectory: true },
      { rootPath: '/Users/me/proj' },
    )
    expect(payload).toEqual({
      type: 'folder',
      resourceId: '/Users/me/proj/src',
      label: 'src',
    })
  })

  it('携带 space 上下文时透传 spaceId / spaceName / tabType', () => {
    const payload = buildFileTreeChatDragPayload(
      { path: '/a/b/README.md', isDirectory: false },
      { spaceId: 'sp1', spaceName: 'Space 1', tabType: 'tabcode' },
    )
    expect(payload).toMatchObject({
      type: 'code_file',
      resourceId: '/a/b/README.md',
      label: 'README.md',
      spaceId: 'sp1',
      spaceName: 'Space 1',
      tabType: 'tabcode',
    })
  })

  it('writeFileTreeChatDragData 只写 DRAG_TYPE_CHAT_CONTEXT，不覆盖 text/plain（保树内移动）', () => {
    const writes = new Map<string, string>()
    writeFileTreeChatDragData(
      { setData: (type: string, value: string) => writes.set(type, value) },
      { path: '/a/b/index.ts', isDirectory: false },
      { rootPath: '/a/b' },
    )
    expect(writes.has('text/plain')).toBe(false)
    expect(JSON.parse(writes.get(DRAG_TYPE_CHAT_CONTEXT) || '{}')).toMatchObject({
      type: 'code_file',
      resourceId: '/a/b/index.ts',
      label: 'index.ts',
    })
  })

  it('写出的 payload 能被聊天 readChatContextDragPayload 接收（端到端连通）', () => {
    const writes = new Map<string, string>()
    writeFileTreeChatDragData(
      { setData: (type: string, value: string) => writes.set(type, value) },
      { path: '/a/b/index.ts', isDirectory: false },
      { rootPath: '/a/b' },
    )
    const restored = readChatContextDragPayload({
      getData: (type: string) => writes.get(type) || '',
    })
    expect(restored).toMatchObject({
      type: 'code_file',
      resourceId: '/a/b/index.ts',
      label: 'index.ts',
      meta: { filePath: '/a/b/index.ts', rootPath: '/a/b' },
    })
  })

  it('目录 payload 也能被聊天接收为 folder 引用', () => {
    const writes = new Map<string, string>()
    writeFileTreeChatDragData(
      { setData: (type: string, value: string) => writes.set(type, value) },
      { path: '/a/b/src', isDirectory: true },
    )
    const restored = readChatContextDragPayload({
      getData: (type: string) => writes.get(type) || '',
    })
    expect(restored).toMatchObject({
      type: 'folder',
      resourceId: '/a/b/src',
      label: 'src',
    })
  })

  it('远控 Workspace 文件保留执行设备路径与 Space 身份', () => {
    const writes = new Map<string, string>()
    writeFileTreeChatDragData(
      { setData: (type: string, value: string) => writes.set(type, value) },
      { path: '/remote/work/source.zip', isDirectory: false },
      { rootPath: '/remote/work', spaceId: 'space-1', tabType: 'remote_workspace_file' },
    )
    expect(readChatContextDragPayload({
      getData: (type: string) => writes.get(type) || '',
    })).toMatchObject({
      type: 'code_file',
      spaceId: 'space-1',
      tabType: 'remote_workspace_file',
      meta: { filePath: '/remote/work/source.zip', rootPath: '/remote/work' },
    })
  })
})
