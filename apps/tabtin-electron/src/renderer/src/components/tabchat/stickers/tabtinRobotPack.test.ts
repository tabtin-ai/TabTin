import { describe, expect, it } from 'vitest'
import {
  TABTIN_ROBOT_PACK_ID,
  TABTIN_ROBOT_STICKERS,
  getTabtinRobotSticker,
  isTabtinRobotStickerMetadata,
  resolveTabtinRobotStickerMetadata,
} from './tabtinRobotPack'

describe('tabtinRobotPack', () => {
  it('exposes five robot stickers with pack id', () => {
    expect(TABTIN_ROBOT_PACK_ID).toBe('tabtin-robot')
    expect(TABTIN_ROBOT_STICKERS).toHaveLength(5)
    expect(getTabtinRobotSticker('happy')?.id).toBe('happy')
    expect(getTabtinRobotSticker('love')).toBeUndefined()
    expect(getTabtinRobotSticker('laugh')).toBeUndefined()
    expect(getTabtinRobotSticker('cry')).toBeUndefined()
    expect(getTabtinRobotSticker('missing')).toBeUndefined()
  })

  it('validates sticker metadata shape', () => {
    expect(isTabtinRobotStickerMetadata({ pack: 'tabtin-robot', id: 'cool' })).toBe(true)
    expect(isTabtinRobotStickerMetadata({ pack: 'other', id: 'cool' })).toBe(false)
    expect(isTabtinRobotStickerMetadata({ pack: 'tabtin-robot', id: 'think' })).toBe(false)
    expect(isTabtinRobotStickerMetadata({ pack: 'tabtin-robot', id: 'nope' })).toBe(false)
    expect(isTabtinRobotStickerMetadata(null)).toBe(false)
  })

  it('resolves sticker from metadata or tabtin-*.png file name', () => {
    expect(
      resolveTabtinRobotStickerMetadata({
        sticker: { pack: 'tabtin-robot', id: 'sad' },
        file_name: 'ignored.png',
      }),
    ).toEqual({ pack: 'tabtin-robot', id: 'sad' })
    expect(
      resolveTabtinRobotStickerMetadata({ file_name: 'tabtin-surprise.png' }),
    ).toEqual({ pack: 'tabtin-robot', id: 'surprise' })
    expect(resolveTabtinRobotStickerMetadata({ file_name: 'photo.png' })).toBeNull()
  })
})
