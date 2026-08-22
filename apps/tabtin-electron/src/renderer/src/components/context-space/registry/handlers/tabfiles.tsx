import React from 'react'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { FileText } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { metaStr } from '../homeSections/metaFieldUtils'

const TabFilesPaneRenderer = React.lazy(() =>
  import('./renderers/TabFilesPaneRenderer').then(m => ({ default: m.TabFilesPaneRenderer }))
)

export const tabfilesHandler: ContextTypeHandler = {
  type: 'file',
  appId: 'tabfiles',
  backendAliases: ['tabfiles'],
  persistOnly: true,
  appEntryMode: 'resources',
  displayLabel: 'Files',
  displayEmoji: '📁',
  agent: {
    displayName: '本地文件',
    capability: '打开 Agent 工作目录里的本地文件产物，支持 .xlsx / .docx / .pdf / .pptx 基础预览',
    aliases: ['file', 'files', '本地文件', '文件'],
    // backendAliases[0]='tabfiles' 是 item_type，真实 CLI 是 `tabtin file`。
    cliKey: 'file',
  },
  resolveTabItem: (id, ctx) => {
    const meta = ctx.persistedItem?.meta ?? {}
    const filename = metaStr(meta, 'filename') || ctx.persistedItem?.title || id.split('/').pop() || id
    return {
      type: 'file',
      id,
      tabKey: ctx.tabKey,
      title: filename,
      meta,
    }
  },
  appMeta: {
    idField: '',
    resolve: (item) => {
      const path = metaStr(item.meta, 'relative_path') || metaStr(item.meta, 'path') || item.id
      const filename = metaStr(item.meta, 'filename') || item.title || item.id.split('/').pop() || item.id
      return {
        current_file_id: path,
        current_file_name: filename,
      }
    },
  },
  attachToChat: {
    refType: 'file',
    buildRef: (item) => {
      // ：优先 file_id（云盘 FileRecord UUID）；本地产物再退到相对路径 / item.id
      const fileId = metaStr(item.meta, 'file_id')
      const path = metaStr(item.meta, 'relative_path') || item.id
      const filename = metaStr(item.meta, 'filename') || item.title || item.id.split('/').pop() || item.id
      return {
        resourceId: fileId || path,
        label: filename,
        meta: {
          artifact_kind: metaStr(item.meta, 'artifact_kind') || undefined,
          file_type: metaStr(item.meta, 'file_type') || undefined,
        },
      }
    },
  },
  getTabLabel: (item) => (
    metaStr(item.meta, 'filename') || item.title || item.id.split('/').pop() || item.id
  ),
  getTabIcon: () => <TabTypeEmoji appIdOrType="tabfiles" />,
  getDragPayload: (item) => ({
    type: 'file',
    id: item.id,
    title: item.title,
    path: metaStr(item.meta, 'relative_path') || item.id,
    fileType: metaStr(item.meta, 'file_type') || undefined,
  }),
  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),
  renderPane: (item) => (
    <React.Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-body text-muted-foreground">
          加载中
        </div>
      }
    >
      <TabFilesPaneRenderer item={item} />
    </React.Suspense>
  ),
}
