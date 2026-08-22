/**
 * 把 UnifiedBlock 里的 image_ref 源文件拷进档案 attachments/，
 * 并把 path 改写为拷贝后的绝对路径（供 block-conversion 转 tabtin-file URL）。
 *
 * 拷贝失败 / 源不存在：保留原 path，转换层会降级为 `[图片: …]` 占位。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { UnifiedBlock, UnifiedMessage } from '@tabtin/agent-import'

function uniqueDestPath(attachmentsDir: string, fileName: string): string {
  const safeBase = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 180) || 'image.png'
  let dest = path.join(attachmentsDir, safeBase)
  if (!fs.existsSync(dest)) return dest
  const ext = path.extname(safeBase)
  const stem = ext ? safeBase.slice(0, -ext.length) : safeBase
  for (let i = 2; i < 10_000; i++) {
    dest = path.join(attachmentsDir, `${stem}-${i}${ext}`)
    if (!fs.existsSync(dest)) return dest
  }
  return path.join(attachmentsDir, `${stem}-${Date.now()}${ext}`)
}

function materializeBlock(block: UnifiedBlock, attachmentsDir: string): UnifiedBlock {
  if (block.type !== 'image_ref') return block
  const src = typeof block.path === 'string' ? block.path.trim() : ''
  if (!src) return block
  try {
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return block
    const dest = uniqueDestPath(attachmentsDir, path.basename(src))
    fs.copyFileSync(src, dest)
    return { ...block, path: dest }
  } catch {
    return block
  }
}

/** 就地拷图并返回新 messages（不改入参引用上的 blocks 数组内容以外的结构）。 */
export function materializeSessionImages(
  messages: UnifiedMessage[],
  attachmentsDir: string,
): UnifiedMessage[] {
  const hasImages = messages.some((m) => (m.blocks ?? []).some((b) => b.type === 'image_ref'))
  if (!hasImages) return messages
  fs.mkdirSync(attachmentsDir, { recursive: true })
  return messages.map((msg) => ({
    ...msg,
    blocks: (msg.blocks ?? []).map((b) => materializeBlock(b, attachmentsDir)),
  }))
}
