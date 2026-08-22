/**
 * 重构来源：apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx（行 81-87、309-315）
 * 拆分时间：2026-04-30
 * 重构原因：RichContentRenderer.tsx 1352 行单文件过大，按职责拆分
 * 职责：集中 kind / resource type → icon 的映射常量，供 RichFallback / RichResourceRef 复用。
 *
 * W6 修 P0（视角 B P0-1，"Agent 产物在 Space 内的打开" 总控 §6.2）：
 *   `RESOURCE_TYPE_ICONS` 之前只有硬编码 5 项（table/doc/slide/video/site）——
 *   后端 W6 改 manifest 驱动放行 18 种 type 后，memo / whiteboard / agenda_event /
 *   document / code_file / email_thread 等 14 种**全部走 fallback `📁`**，与实际
 *   语义严重错位（连 W6 后端主用的 `document` 都被显示成文件夹）。
 *
 * 本表与 `apps/tabtin_django/apps/services/common/manifest_opens.py
 * get_supported_resource_types()` 聚合的 manifest opens.types 全集对齐——
 * 18 个 type 覆盖率 100%，新增 manifest type 时同步在此扩展（参照 §6.2 L65 长期治理项）。
 */

import type React from 'react'
import { Image as ImageIcon, Table2, Link2, FileDown, LayoutTemplate } from 'lucide-react'

export const KIND_ICONS: Record<string, React.ElementType> = {
  image: ImageIcon,
  table_preview: Table2,
  resource_ref: Link2,
  file: FileDown,
  widget: LayoutTemplate,
}

/**
 * resource_type → emoji 映射。
 *
 * 设计取向：
 *   - **覆盖 manifest opens.types 全集**——见模块 docstring 顶部的契约
 *   - 同语义系列共用一图标（如 table / table_selection / field 都用 📊；
 *     code_file / code_selection 用 💻），既减少视觉噪音又对齐 ContextRefType 分组
 *   - `doc` 是 W6 之前的 legacy 命名（manifest 现统一 `document`）；保留别名
 *     映射避免历史 blocks_json payload 渲染回退到 fallback
 *   - 真值 fallback `📁` 在 RichResourceRef.tsx:40 处兜底（未声明 type 时显示）
 */
export const RESOURCE_TYPE_ICONS: Record<string, string> = {
  // ── 数据 / 表格类 ──
  table: '📊',
  table_selection: '📊',
  field: '🏷️',

  // ── 文档类 ──
  document: '📄',
  doc: '📄',           // legacy 别名（manifest 用 'document'，但 W6 之前历史 payload 可能仍 'doc'）
  doc_selection: '📄',

  // ── 代码类 ──
  code_file: '💻',
  code_selection: '💻',

  // ── 笔记 / 创作类 ──
  memo: '📝',
  whiteboard: '🎨',

  // ── 日程 / 自动化 ──
  agenda_event: '📅',
  tracker: '🎯',
  tabtracker: '🎯',

  // ── 网页类 ──
  site: '🌐',
  webpage: '🌐',
  web_selection: '🌐',
  web_annotation: '🌐',

  // ── 媒体类 ──
  slide: '📽️',
  video: '🎬',

  // ── 文件系统类 ──
  folder: '📁',
  file: '📎',          // 差异化避免与 fallback `📁` 撞

  // ── 邮件 ──
  email_thread: '✉️',
}
