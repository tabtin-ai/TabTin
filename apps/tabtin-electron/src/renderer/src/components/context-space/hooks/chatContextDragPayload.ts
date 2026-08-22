import type { ContextInjectPayload } from '@/stores/useContextInjectionStore'
import { DRAG_TYPE_CHAT_CONTEXT } from '@/utils/split-coordinator'
import type { SpaceContextItem } from '@/services/spaceApi'
import type {
  ContextItem,
  ContextItemType,
  ContextRegistry,
  ContextTabKey,
} from '../registry'

type ChatContextDragOptions = {
  spaceId?: string | null
  spaceName?: string | null
}

function optionalString(value: string | null | undefined): string | undefined {
  return value && value.trim() ? value : undefined
}

export function buildChatContextDragPayload(
  item: ContextItem,
  registry: ContextRegistry,
  options: ChatContextDragOptions = {},
): ContextInjectPayload | null {
  const built = registry.buildContextAttachment(item)
  if (!built) return null

  return {
    type: built.refType,
    resourceId: built.resourceId,
    label: built.label,
    tabType: item.type as string,
    ...(built.meta ? { meta: built.meta } : {}),
    ...(optionalString(options.spaceId) ? { spaceId: optionalString(options.spaceId) } : {}),
    ...(optionalString(options.spaceName) ? { spaceName: optionalString(options.spaceName) } : {}),
  }
}

export function buildSpaceItemChatContextDragPayload(
  item: SpaceContextItem,
  registry: ContextRegistry,
): ContextInjectPayload | null {
  if (!item.resource_id) return null
  const type = registry.normalizeBackendType(item.item_type) as ContextItemType
  const resourceId = item.resource_id
  const contextItem: ContextItem = {
    type,
    id: resourceId,
    tabKey: `${type}:${resourceId}` as ContextTabKey,
    title: item.title,
    meta: item.metadata ?? undefined,
  }

  return buildChatContextDragPayload(contextItem, registry, {
    spaceId: item.space_id,
    spaceName: item.space_name,
  })
}

export function writeChatContextDragPayload(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  payload: ContextInjectPayload | null,
): boolean {
  if (!payload) return false
  dataTransfer.setData(DRAG_TYPE_CHAT_CONTEXT, JSON.stringify(payload))
  dataTransfer.setData('text/plain', payload.label)
  return true
}

type FileTreeNode = { path: string; isDirectory: boolean }

type FileTreeChatDragOptions = ChatContextDragOptions & {
  rootPath?: string | null
  tabType?: string
}

function pathBasename(filePath: string): string {
  return filePath.split(/[/\\]/).filter(Boolean).pop() || filePath
}

/**
 * 把文件树节点构造成聊天上下文引用载荷：文件 → `code_file`，目录 → `folder`。
 * 与右键「发送到对话」(`emitContextInject`) 同构，使「拖文件树项到对话框」复用既有
 * `readChatContextDragPayload` → `onAddContextRef` 链路。
 *
 * 落点侧统一保留 Workspace 路径引用；本地与远控文件都由执行设备按需读取，
 * 不把已存在的 Workspace 文件重新上传为对话附件。
 */
export function buildFileTreeChatDragPayload(
  node: FileTreeNode,
  options: FileTreeChatDragOptions = {},
): ContextInjectPayload {
  const meta: Record<string, unknown> = {}
  if (!node.isDirectory) {
    meta.filePath = node.path
    const rootPath = optionalString(options.rootPath)
    if (rootPath) meta.rootPath = rootPath
  }
  return {
    type: node.isDirectory ? 'folder' : 'code_file',
    resourceId: node.path,
    label: pathBasename(node.path),
    ...(optionalString(options.spaceId) ? { spaceId: optionalString(options.spaceId) } : {}),
    ...(optionalString(options.spaceName) ? { spaceName: optionalString(options.spaceName) } : {}),
    ...(options.tabType ? { tabType: options.tabType } : {}),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  }
}

/**
 * 在文件树 dragstart 时，仅写入 `DRAG_TYPE_CHAT_CONTEXT`（不覆盖 `text/plain`，
 * 后者仍由树内移动复用为源路径）。调用方需自行把 `effectAllowed` 放宽到含 copy，
 * 否则浏览器会判定「move 源 + copy 落点」非法而拒绝拖入对话框。
 */
export function writeFileTreeChatDragData(
  dataTransfer: Pick<DataTransfer, 'setData'>,
  node: FileTreeNode,
  options?: FileTreeChatDragOptions,
): void {
  const payload = buildFileTreeChatDragPayload(node, options)
  dataTransfer.setData(DRAG_TYPE_CHAT_CONTEXT, JSON.stringify(payload))
}
