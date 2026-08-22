import { describe, expect, it } from 'vitest'
import {
  canSubmitActivePresets,
  findFirstPresetSendValidationError,
} from '../composerPresetSendValidation'
import type { ComposerPresetDescriptor, PresetInstance } from '../registry/types'

const preset: PresetInstance = {
  instanceId: 'inst-1',
  presetId: 'demo',
  state: { title: '' },
  slotAttachments: {},
  activeAddonKeys: [],
  triggerContext: undefined,
  collapsed: false,
  errors: {},
}

const desc: ComposerPresetDescriptor = {
  id: 'demo',
  label: 'Demo',
  fields: [{ key: 'title', type: 'input', required: true }],
}

describe('composerPresetSendValidation', () => {
  it('returns first required field error', () => {
    const error = findFirstPresetSendValidationError([preset], () => desc)
    expect(error).toEqual({
      instanceId: 'inst-1',
      fieldKey: 'title',
      message: '此字段为必填',
    })
  })

  it('passes when required field filled', () => {
    const filled = { ...preset, state: { title: 'ok' } }
    expect(findFirstPresetSendValidationError([filled], () => desc)).toBeNull()
  })

  it('validates upload required slot attachments', () => {
    const uploadDesc: ComposerPresetDescriptor = {
      id: 'upload-demo',
      label: 'Upload',
      fields: [{ key: 'file', type: 'upload', required: true }],
    }
    const uploadPreset: PresetInstance = {
      ...preset,
      presetId: 'upload-demo',
      slotAttachments: { file: [] },
    }
    const error = findFirstPresetSendValidationError([uploadPreset], () => uploadDesc)
    expect(error?.fieldKey).toBe('file')
  })

  it('respects canSubmit', () => {
    const blockingDesc: ComposerPresetDescriptor = {
      ...desc,
      canSubmit: () => false,
    }
    expect(canSubmitActivePresets([{ ...preset, state: { title: 'ok' } }], () => blockingDesc)).toBe(false)
  })
})
