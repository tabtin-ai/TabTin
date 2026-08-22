import type { AnyExtension } from '@tiptap/core'
import type { Doc as YDoc } from 'yjs'
import type { HocuspocusProvider } from '@hocuspocus/provider'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'

export interface TabDocCollaborationUser {
  id: string
  name: string
  color: string
  type?: string
  avatar?: string
}

function renderCollaborationCursor(user: Record<string, unknown>): HTMLElement {
  const name = typeof user.name === 'string' && user.name.trim() ? user.name : 'User'
  const color = typeof user.color === 'string' && user.color.trim() ? user.color : '#1E88E5'
  const cursor = document.createElement('span')
  cursor.classList.add('tabdoc-collaboration-cursor__caret')
  cursor.style.borderColor = color
  cursor.style.color = color

  const label = document.createElement('span')
  label.classList.add('tabdoc-collaboration-cursor__label')
  label.style.backgroundColor = color
  label.textContent = name

  cursor.appendChild(label)
  return cursor
}

/**
 * 根据 Y.Doc 和可选的 HocuspocusProvider 创建 Tiptap 协作扩展列表。
 *
 * 封装 @tiptap/extension-collaboration 和 @tiptap/extension-collaboration-cursor，
 * 使宿主无需直接依赖这两个包。
 */
export function createCollaborationExtensions(
  ydoc: YDoc,
  provider?: HocuspocusProvider | null,
  user?: TabDocCollaborationUser | null,
): AnyExtension[] {
  const extensions: AnyExtension[] = [
    Collaboration.configure({ document: ydoc }),
  ]
  if (provider && user) {
    extensions.push(CollaborationCursor.configure({
      provider,
      user,
      render: renderCollaborationCursor,
    }))
  }
  return extensions
}
