/**
 * 协作文档扩展配置
 *
 * 在默认编辑器扩展基础上添加 Y.js 协作所需的扩展:
 * - Collaboration: Y.js 文档同步
 * - CollaborationCursor: 协作光标
 * - UniqueID: 为每个 Block 分配稳定 UUID
 * - Y.UndoManager: 协作模式下的 Undo/Redo
 *
 * 使用方式:
 *   const { extensions, undoManager } = await createCollaborativeDocExtensions({
 *     ydoc: new Y.Doc(),
 *     provider: hocuspocusProvider,
 *     user: { name: 'Alice', color: '#ff0000' },
 *   })
 */

import type { AnyExtension } from '@tiptap/core'
import {
  createDefaultDocExtensions,
  type CreateDefaultDocExtensionsInput,
} from './createDefaultDocExtensions.js'

/**
 * 需要协作的 Block 类型列表
 * UniqueID 扩展会给这些类型的节点自动生成 blockId
 */
export const COLLABORATIVE_BLOCK_TYPES = [
  'heading',
  'paragraph',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'table',
  'horizontalRule',
  'tabdataBlock',
  'tabwhiteboard',
  'htmlBlock',
]

export interface CollaborativeDocExtensionsInput extends CreateDefaultDocExtensionsInput {
  /**
   * Y.js Document 实例
   * 必须在调用前创建好
   */
  ydoc: any // Y.Doc — 使用 any 避免强依赖 yjs 类型

  /**
   * Hocuspocus Provider 实例（可选，用于协作光标）
   */
  provider?: any

  /**
   * 当前用户信息（用于协作光标展示）
   */
  user?: {
    name: string
    color: string
  }

  /**
   * Y.js fragment 名称，默认 'default'
   */
  fragmentName?: string
}

export interface CollaborativeDocExtensionsResult {
  extensions: AnyExtension[]
  /**
   * Y.UndoManager 实例，协作模式下管理 Undo/Redo。
   * 调用方应在编辑器销毁时调用 undoManager.destroy()。
   */
  undoManager: any // Y.UndoManager
}

/**
 * 创建带协作功能的文档编辑器扩展列表
 *
 * 注意: 需要安装以下依赖:
 * - @tiptap/extension-collaboration
 * - @tiptap/extension-collaboration-cursor
 * - @tiptap/extension-unique-id (或使用 @tiptap-pro/extension-unique-id)
 * - yjs
 * - y-prosemirror
 *
 * 这些依赖作为 peerDependencies，由使用方（如 tabtin-electron）安装。
 */
export const createCollaborativeDocExtensions = async (
  input: CollaborativeDocExtensionsInput
): Promise<CollaborativeDocExtensionsResult> => {
  const {
    ydoc,
    provider,
    user,
    fragmentName = 'default',
    ...baseInput
  } = input

  // 基础扩展：
  // - disableMarkdown: 协作模式下由 Y.js 管理状态
  // - disableHistory: 协作模式下 StarterKit History 与 Collaboration 冲突，
  //   Undo/Redo 由 Y.UndoManager 接管（CAP-027）
  const baseExtensions = createDefaultDocExtensions({
    ...baseInput,
    disableMarkdown: true,
    disableHistory: true,
  })

  // 动态导入协作扩展（避免在非协作场景下加载 yjs）
  const [
    { Collaboration },
    { CollaborationCursor },
    Y,
  ] = await Promise.all([
    import('@tiptap/extension-collaboration'),
    import('@tiptap/extension-collaboration-cursor'),
    import('yjs'),
  ])

  const fragment = ydoc.getXmlFragment(fragmentName)

  const collaborativeExtensions: AnyExtension[] = [
    ...baseExtensions,

    // Y.js 文档同步
    Collaboration.configure({
      document: ydoc,
      fragment,
    }),
  ]

  // 协作光标（可选，需要 provider）
  if (provider && user) {
    collaborativeExtensions.push(
      CollaborationCursor.configure({
        provider,
        user,
      })
    )
  }

  // CAP-028: Y.UndoManager — 协作模式下替代 StarterKit History
  // trackedOrigins 仅跟踪 null（本地用户编辑），不跟踪来自远端同步的变更
  const undoManager = new Y.UndoManager(fragment, {
    trackedOrigins: new Set([null]),
  })

  // UniqueID 扩展 — 给每个 Block 分配稳定 UUID
  // 用于 Block 级归属追踪和 Agent Block 级操作
  try {
    const { UniqueID } = await import('@tiptap/extension-unique-id')
    collaborativeExtensions.push(
      UniqueID.configure({
        types: COLLABORATIVE_BLOCK_TYPES,
        attributeName: 'blockId',
      })
    )
  } catch {
    // UniqueID 是可选的，如果未安装则跳过
    console.warn('[doc-editor] @tiptap/extension-unique-id not available, skipping blockId generation')
  }

  return { extensions: collaborativeExtensions, undoManager }
}
