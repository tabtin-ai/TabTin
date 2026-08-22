/**
 * 聊天资源预览 - 类型定义
 *
 * 把消息中可被预览的资源抽象为统一形态，供全屏 Lightbox 渲染与同回合切换使用。
 *
 * 支持 kind：
 *   - image / video / audio：原生媒体元素
 *   - pdf：基于 react-pdf 的 PdfViewer
 *   - docx / xlsx / pptx / csv：文档/数据预览（懒加载共享 viewer + 下载兜底）
 *   - txt / json：纯文本只读预览（TextFileEditor）
 *   - md：Markdown 渲染预览（MarkdownViewer）
 *   - widget：show_widget 图示（Lightbox 内运行时 wrapWidgetCode → iframe）
 *   - file：不可预览，仅展示文件名 + 下载入口
 */

export type PreviewResourceKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'csv'
  | 'txt'
  | 'md'
  | 'json'
  | 'widget'
  | 'file'

export type WidgetPreviewFormat = 'svg' | 'html' | 'mermaid'

export interface PreviewResource {
  /** 唯一 key，用于 React 列表与定位（如 `${messageId}:widget:${widgetId}`） */
  id: string
  kind: PreviewResourceKind
  /**
   * 资源 URL（https / blob / data）。
   * widget：用 image_url 占位（可空），真正渲染靠 code + wrapWidgetCode。
   */
  url: string
  /** 显示名（文件名 / 标题 / fallback） */
  name: string
  mimeType?: string
  size?: number
  /** 来源 message id（用于 debug、命中、定位） */
  sourceMessageId?: string
  /** 服务端文件 id；命中本地 attachmentBlobCache 的 prime 缓存（场景 1） */
  fileId?: string
  /** show_widget：widget_id */
  widgetId?: string
  /** show_widget：format */
  format?: WidgetPreviewFormat
  /** show_widget：可渲染源码（mermaid 优先 rendered_code） */
  code?: string
  /** show_widget：烤图 PNG URL（无 code 时降级） */
  imageUrl?: string
}
