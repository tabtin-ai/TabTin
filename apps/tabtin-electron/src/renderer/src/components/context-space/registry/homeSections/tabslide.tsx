/**
 * TabSlide App 的 Home Section —— 演示文稿列表
 *
 * 数据来源：useUnifiedResources（WS 实时更新）
 * 新建演示文稿后通过 context.sync WS 推送自动出现在列表中。
 */
import { Presentation } from 'lucide-react'
import { createResourceListSection } from './ResourceListSection'

export const tabslideHomeSection = createResourceListSection({
  appId: 'tabslide',
  icon: Presentation,
  createLabelKey: 'home.assetBrowser.newPpt',
  emptyLabelKey: 'home.assetBrowser.slidesEmpty',
  unavailableLabelKey: 'home.assetBrowser.slidesUnavailable',
  untitledLabelKey: 'label.untitledPpt',
  tabLabelKey: 'home.assetBrowser.slides',
  gridEmoji: '📽️',
})
