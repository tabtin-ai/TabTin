import { toast } from '@tabtin/smartsheet-ui'
import type { TFunction } from 'i18next'
import { useComposerPresetStore } from '@/stores/useComposerPresetStore'
import type { PresetInstance } from '../../composer-presets/registry/types'
import { COMPOSER_PRESET_PENDING_TYPE } from '../../composer-presets/registry/types'
import { getComposerPreset } from '../../composer-presets/registry/composerPresetRegistry'
import {
  canSubmitActivePresets,
  findFirstPresetSendValidationError,
} from '../../composer-presets/composerPresetSendValidation'
import type { ChatAttachment } from '../../types'

export interface MergedPresetSendPayload {
  ok: true
  finalBlocks: Array<Record<string, unknown>>
  finalAttachments: ChatAttachment[]
}

export interface PresetSendPayloadBlocked {
  ok: false
}

export function mergePresetSendPayload(input: {
  hasActivePresets: boolean
  resolvedPresetScopeId: string | null
  activePresets: PresetInstance[]
  mergedBlocks: Array<Record<string, unknown>>
  mergedAttachments: ChatAttachment[]
  t: TFunction
}): MergedPresetSendPayload | PresetSendPayloadBlocked {
  let { mergedBlocks, mergedAttachments } = input
  if (!input.hasActivePresets || !input.resolvedPresetScopeId) {
    return {
      ok: true,
      finalBlocks: mergedBlocks,
      finalAttachments: mergedAttachments,
    }
  }

  const store = useComposerPresetStore.getState()
  const resolvePreset = (presetId: string) => getComposerPreset(presetId) ?? undefined
  const validationError = findFirstPresetSendValidationError(input.activePresets, resolvePreset)
  if (validationError) {
    store.setFieldError(
      input.resolvedPresetScopeId,
      validationError.instanceId,
      validationError.fieldKey,
      validationError.message,
    )
    return { ok: false }
  }
  if (!canSubmitActivePresets(input.activePresets, resolvePreset)) {
    toast.warning(input.t('input.presetCannotSubmit', { defaultValue: '当前参数不满足提交条件，请检查后重试' }))
    return { ok: false }
  }

  const slotAtts = store.collectSlotAttachments(input.resolvedPresetScopeId)
  mergedAttachments = [...mergedAttachments, ...slotAtts]

  for (const preset of input.activePresets) {
    mergedBlocks.push({
      type: COMPOSER_PRESET_PENDING_TYPE,
      instance_id: preset.instanceId,
      preset_id: preset.presetId,
      state: preset.state,
      trigger_context: preset.triggerContext,
      slot_keys: Object.entries(preset.slotAttachments)
        .filter(([, atts]) => atts.length > 0)
        .map(([key]) => key),
    })
  }

  return {
    ok: true,
    finalBlocks: mergedBlocks,
    finalAttachments: mergedAttachments,
  }
}
