/**
 * TabDoc App 的 Home Section —— 文档列表
 *
 * 数据来源：useUnifiedResources（WS 实时更新）
 * 后端 DocumentService 已通过 ResourceBridge 将文档同步到 ContextItem (item_type='tabdoc')。
 * 新建/修改/归档文档后通过 context.sync WS 推送自动反映在列表中。
 */
import { FileText } from 'lucide-react'
import { createResourceListSection } from './ResourceListSection'

export const tabdocHomeSection = createResourceListSection({
  appId: 'tabdoc',
  icon: FileText,
  createLabelKey: 'home.assetBrowser.newDocument',
  emptyLabelKey: 'home.assetBrowser.documentsEmpty',
  unavailableLabelKey: 'home.assetBrowser.documentsUnavailable',
  untitledLabelKey: 'label.untitledDoc',
  tabLabelKey: 'home.assetBrowser.documents',
  gridEmoji: '📄',
})
