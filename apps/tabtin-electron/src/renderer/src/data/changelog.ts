export interface ChangelogEntry {
  version: string
  date: string
  title: string
  changes: Array<{
    type: 'new' | 'improved' | 'fixed' | 'breaking'
    text: string
  }>
}

export const changelog: ChangelogEntry[] = [
  {
    version: '1.0.0',
    date: '2026-03-29',
    title: '正式版发布',
    changes: [
      { type: 'new', text: '关键帧动画系统扩展：支持模糊、音量、字体大小、字间距、行高等更多属性的关键帧动画' },
      { type: 'new', text: '关键帧时间点吸附：编辑时播放头和元素可自动吸附到关键帧位置' },
      { type: 'new', text: '版本更新日志：在设置 → 关于页面查看历史版本更新记录' },
      { type: 'improved', text: '关键帧属性面板：按类别分组展示，支持更多元素类型的属性动画' },
      { type: 'improved', text: '渲染引擎：文本节点支持关键帧驱动的字体大小动画' },
    ],
  },
]
