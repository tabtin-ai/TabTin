import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerComposerPreset,
  getComposerPreset,
  getPresetsByCategory,
  getAllPresets,
  defaultSerializeForSend,
  __resetPresetsForTesting,
} from '../registry/composerPresetRegistry'

beforeEach(() => {
  __resetPresetsForTesting()
})

describe('composerPresetRegistry', () => {
  const samplePreset = {
    id: 'test.sample',
    labelKey: 'test:sample.label',
    category: 'test',
    fields: [{ key: 'name', type: 'input' as const }],
  }

  describe('register / get', () => {
    it('注册后可查询', () => {
      registerComposerPreset(samplePreset)
      expect(getComposerPreset('test.sample')).toEqual(samplePreset)
    })

    it('未注册返回 null', () => {
      expect(getComposerPreset('nonexistent')).toBeNull()
    })

    it('无 fields/renderer/promptTemplate 时 console.warn', () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      registerComposerPreset({ id: 'test.empty', labelKey: 'x', category: 'x' })
      expect(spy).toHaveBeenCalledWith(expect.stringContaining('test.empty'))
      spy.mockRestore()
    })
  })

  describe('getPresetsByCategory', () => {
    it('按 category 过滤', () => {
      registerComposerPreset(samplePreset)
      registerComposerPreset({ ...samplePreset, id: 'other.preset', category: 'other' })
      expect(getPresetsByCategory('test')).toHaveLength(1)
      expect(getPresetsByCategory('test')[0].id).toBe('test.sample')
    })
  })

  describe('getAllPresets', () => {
    it('返回所有', () => {
      registerComposerPreset(samplePreset)
      registerComposerPreset({ ...samplePreset, id: 'test.two' })
      expect(getAllPresets()).toHaveLength(2)
    })
  })

  describe('__resetPresetsForTesting', () => {
    it('重置后为空', () => {
      registerComposerPreset(samplePreset)
      __resetPresetsForTesting()
      expect(getAllPresets()).toHaveLength(0)
    })
  })
})

describe('defaultSerializeForSend', () => {
  it('基本序列化', () => {
    const result = defaultSerializeForSend(
      'test.preset',
      { prompt: 'hello', duration: 5 },
      {},
    )
    expect(result).toEqual({
      type: 'composer_preset',
      preset_id: 'test.preset',
      params: { prompt: 'hello', duration: 5 },
    })
  })

  it('空值字段过滤', () => {
    const result = defaultSerializeForSend(
      'test.preset',
      { a: 'val', b: '', c: null, d: undefined },
      {},
    )
    expect(result.params).toEqual({ a: 'val' })
  })

  it('triggerContext 有值时包含', () => {
    const result = defaultSerializeForSend(
      'test.preset',
      { x: 1 },
      {},
      { insert_at: 5 },
    )
    expect(result.trigger_context).toEqual({ insert_at: 5 })
  })

  it('triggerContext 为空对象时不包含', () => {
    const result = defaultSerializeForSend('test.preset', { x: 1 }, {}, {})
    expect(result).not.toHaveProperty('trigger_context')
  })

  it('单文件 upload 替换为 URL + fileId', () => {
    const result = defaultSerializeForSend(
      'test.preset',
      { ref: 'local' },
      { ref: [{ url: 'https://cdn/img.png', fileId: 'f1' }] },
    )
    expect(result.params).toEqual({
      ref: 'https://cdn/img.png',
      ref_file_id: 'f1',
    })
  })

  it('多文件 upload 替换为数组', () => {
    const result = defaultSerializeForSend(
      'test.preset',
      { imgs: 'placeholder' },
      {
        imgs: [
          { url: 'https://cdn/1.png', fileId: 'f1' },
          { url: 'https://cdn/2.png', fileId: 'f2' },
        ],
      },
    )
    expect(result.params).toEqual({
      imgs: ['https://cdn/1.png', 'https://cdn/2.png'],
      imgs_file_ids: ['f1', 'f2'],
    })
  })
})
