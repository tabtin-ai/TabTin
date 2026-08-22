import { beforeEach, describe, expect, it } from 'vitest'
import { resolvePresetBlocks } from '../resolvePresetBlocks'
import {
  registerComposerPreset,
  __resetPresetsForTesting,
} from '../registry/composerPresetRegistry'
import { COMPOSER_PRESET_PENDING_TYPE } from '../registry/types'

beforeEach(() => {
  __resetPresetsForTesting()
})

describe('resolvePresetBlocks', () => {
  it('非 preset block 原样保留', async () => {
    const blocks = [{ type: 'text', content: 'hello' }]
    const result = await resolvePresetBlocks(blocks, [])
    expect(result).toEqual(blocks)
  })

  it('pending block 转换为 final block（默认序列化）', async () => {
    registerComposerPreset({
      id: 'test.preset',
      labelKey: 'test',
      category: 'test',
      fields: [{ key: 'prompt', type: 'textarea' }],
    })

    const blocks = [
      {
        type: COMPOSER_PRESET_PENDING_TYPE,
        instance_id: 'inst-1',
        preset_id: 'test.preset',
        state: { prompt: 'make a video' },
        trigger_context: { insert_at: 5 },
        slot_keys: [],
      },
    ]

    const result = await resolvePresetBlocks(blocks, [])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      type: 'composer_preset',
      preset_id: 'test.preset',
      params: { prompt: 'make a video' },
      trigger_context: { insert_at: 5 },
    })
  })

  it('upload 附件 URL 替换进 params', async () => {
    registerComposerPreset({
      id: 'test.upload',
      labelKey: 'test',
      category: 'test',
      fields: [
        { key: 'ref', type: 'upload' },
        { key: 'desc', type: 'textarea' },
      ],
    })

    const blocks = [
      {
        type: COMPOSER_PRESET_PENDING_TYPE,
        instance_id: 'inst-2',
        preset_id: 'test.upload',
        state: { ref: 'local-placeholder', desc: 'a description' },
        slot_keys: ['ref'],
      },
    ]

    const uploaded = [
      {
        id: 'att-1',
        name: 'img.png',
        presetSlotKey: 'ref',
        presetInstanceId: 'inst-2',
        remoteUrl: 'https://cdn.example.com/img.png',
        fileId: 'file-123',
      },
    ] as import('../../types').ChatAttachment[]

    const result = await resolvePresetBlocks(blocks, uploaded)
    expect(result[0]).toMatchObject({
      type: 'composer_preset',
      params: {
        ref: 'https://cdn.example.com/img.png',
        ref_file_id: 'file-123',
        desc: 'a description',
      },
    })
  })

  it('多文件 upload 生成数组', async () => {
    registerComposerPreset({
      id: 'test.multi',
      labelKey: 'test',
      category: 'test',
      fields: [{ key: 'images', type: 'upload' }],
    })

    const blocks = [
      {
        type: COMPOSER_PRESET_PENDING_TYPE,
        instance_id: 'inst-3',
        preset_id: 'test.multi',
        state: { images: 'placeholder' },
        slot_keys: ['images'],
      },
    ]

    const uploaded = [
      {
        id: 'a1', name: '1.png',
        presetSlotKey: 'images', presetInstanceId: 'inst-3',
        remoteUrl: 'https://cdn.example.com/1.png', fileId: 'f1',
      },
      {
        id: 'a2', name: '2.png',
        presetSlotKey: 'images', presetInstanceId: 'inst-3',
        remoteUrl: 'https://cdn.example.com/2.png', fileId: 'f2',
      },
    ] as import('../../types').ChatAttachment[]

    const result = await resolvePresetBlocks(blocks, uploaded)
    expect(result[0]).toMatchObject({
      params: {
        images: ['https://cdn.example.com/1.png', 'https://cdn.example.com/2.png'],
        images_file_ids: ['f1', 'f2'],
      },
    })
  })

  it('空值字段不进 params', async () => {
    registerComposerPreset({
      id: 'test.empty',
      labelKey: 'test',
      category: 'test',
      fields: [
        { key: 'a', type: 'input' },
        { key: 'b', type: 'input' },
      ],
    })

    const blocks = [
      {
        type: COMPOSER_PRESET_PENDING_TYPE,
        instance_id: 'inst-4',
        preset_id: 'test.empty',
        state: { a: 'value', b: '', c: null },
        slot_keys: [],
      },
    ]

    const result = await resolvePresetBlocks(blocks, [])
    expect(result[0]).toMatchObject({ params: { a: 'value' } })
    expect((result[0] as Record<string, unknown>).params).not.toHaveProperty('b')
  })

  it('自定义 serializeForSend 优先', async () => {
    registerComposerPreset({
      id: 'test.custom',
      labelKey: 'test',
      category: 'test',
      fields: [{ key: 'x', type: 'input' }],
      serializeForSend: (state, _slots, ctx) => ({
        type: 'composer_preset' as const,
        preset_id: 'test.custom',
        params: { transformed: `[${state.x}]` },
        trigger_context: ctx,
      }),
    })

    const blocks = [
      {
        type: COMPOSER_PRESET_PENDING_TYPE,
        instance_id: 'inst-5',
        preset_id: 'test.custom',
        state: { x: 'hello' },
        slot_keys: [],
      },
    ]

    const result = await resolvePresetBlocks(blocks, [])
    expect(result[0]).toMatchObject({ params: { transformed: '[hello]' } })
  })
})
