import { describe, expect, it } from 'vitest'

import {
  COLLECTION_FOLDER_MIME,
  COLLECTION_ITEM_MIME,
} from '@/components/context-space/hooks/collectionMime'
import { DRAG_TYPE_CHAT_CONTEXT } from '@/utils/split-coordinator'
import { classifyCloudDriveChatDrop } from '../chatCloudDriveDrop'

describe('classifyCloudDriveChatDrop', () => {
  it('有效 chat context 优先', () => {
    expect(classifyCloudDriveChatDrop(
      [COLLECTION_ITEM_MIME, DRAG_TYPE_CHAT_CONTEXT],
      true,
    )).toBe('chat_context')
  })

  it('云盘文件夹 MIME 识别为不可添加', () => {
    expect(classifyCloudDriveChatDrop([COLLECTION_FOLDER_MIME], false)).toBe('cloud_folder')
  })

  it('云盘资源移动 MIME 但无有效 context', () => {
    expect(classifyCloudDriveChatDrop([COLLECTION_ITEM_MIME], false)).toBe(
      'cloud_item_without_context',
    )
  })

  it('普通文件拖入走 other', () => {
    expect(classifyCloudDriveChatDrop(['Files'], false)).toBe('other')
  })
})
