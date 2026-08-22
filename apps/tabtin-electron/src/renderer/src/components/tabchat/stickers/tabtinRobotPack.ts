/**
 * TabTin 水墨小机器人表情包 registry。
 * 面板预览与发送共用同一套资产；发送时再栅格化为 PNG。
 */

import coolSrc from '@/assets/stickers/tabtin-robot/cool.svg?url'
import happySrc from '@/assets/stickers/tabtin-robot/happy.svg?url'
import neutralSrc from '@/assets/stickers/tabtin-robot/neutral.svg?url'
import sadSrc from '@/assets/stickers/tabtin-robot/sad.svg?url'
import surpriseSrc from '@/assets/stickers/tabtin-robot/surprise.svg?url'

export const TABTIN_ROBOT_PACK_ID = 'tabtin-robot' as const

export type TabtinRobotStickerId =
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'surprise'
  | 'cool'

export interface TabtinRobotSticker {
  id: TabtinRobotStickerId
  /** i18n key under tabchat.stickers.* */
  labelKey: string
  src: string
}

export const TABTIN_ROBOT_STICKERS: TabtinRobotSticker[] = [
  { id: 'neutral', labelKey: 'stickers.neutral', src: neutralSrc },
  { id: 'happy', labelKey: 'stickers.happy', src: happySrc },
  { id: 'sad', labelKey: 'stickers.sad', src: sadSrc },
  { id: 'surprise', labelKey: 'stickers.surprise', src: surpriseSrc },
  { id: 'cool', labelKey: 'stickers.cool', src: coolSrc },
]

export function getTabtinRobotSticker(id: string): TabtinRobotSticker | undefined {
  return TABTIN_ROBOT_STICKERS.find((item) => item.id === id)
}

export interface StickerMetadata {
  pack: typeof TABTIN_ROBOT_PACK_ID
  id: TabtinRobotStickerId
}

export function isTabtinRobotStickerMetadata(
  value: unknown,
): value is StickerMetadata {
  if (!value || typeof value !== 'object') return false
  const sticker = value as { pack?: unknown; id?: unknown }
  return (
    sticker.pack === TABTIN_ROBOT_PACK_ID
    && typeof sticker.id === 'string'
    && TABTIN_ROBOT_STICKERS.some((item) => item.id === sticker.id)
  )
}

/** 发送产物文件名：tabtin-{id}.png（历史消息曾丢失 metadata.sticker 时的回退） */
const TABTIN_STICKER_FILENAME_RE = /^tabtin-(neutral|happy|sad|surprise|cool)\.png$/i

/**
 * 解析气泡贴纸语义：优先 metadata.sticker；否则用发送时约定的文件名回退，
 * 避免旧消息因后端曾剥离 sticker 字段而按普通大图渲染。
 */
export function resolveTabtinRobotStickerMetadata(
  metadata: { sticker?: unknown; file_name?: unknown } | null | undefined,
): StickerMetadata | null {
  if (isTabtinRobotStickerMetadata(metadata?.sticker)) {
    return metadata.sticker
  }
  const fileName = metadata?.file_name
  if (typeof fileName !== 'string') return null
  const match = TABTIN_STICKER_FILENAME_RE.exec(fileName.trim())
  if (!match) return null
  const id = match[1].toLowerCase() as TabtinRobotStickerId
  return { pack: TABTIN_ROBOT_PACK_ID, id }
}
