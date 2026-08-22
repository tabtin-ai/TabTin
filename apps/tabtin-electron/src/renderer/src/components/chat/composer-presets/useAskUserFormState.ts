/**
 * useAskUserFormState — AskUser 结构化表单的共享状态与上传管线
 *
 * Phase 1 Review 发现 ConfigConfirmCard 复制了 FieldsForm 的 9 个 hook 调用 + 80 行
 * 状态管理代码，且**漏掉了 upload 字段的异步上传逻辑**（带 upload 字段的 approve
 * 表单提交时附件根本不会上 OSS，是静默 bug）。本 hook 把状态、handlers、附件上传
 * 编排统一收敛，让 FieldsForm 与 ConfigConfirmCard 共享同一份正确实现。
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { PresetFieldDef, AddonParamDef } from '@tabtin/chat-client'
import {
  applyAddonDefaults,
  buildGroupedPresetFields,
  buildInitialAskUserFieldState,
  resolveDefaultActiveAddonKeys,
  toPresetAddon,
} from './askUserFieldAdapter'
import type { ChatAttachment } from '../types'
import { createAttachment } from '../types'
import type { PresetField, PresetAddon } from './registry/types'

export interface UseAskUserFormStateResult {
  // 派生 schema
  presetFields: PresetField[]
  presetAddons: PresetAddon[]
  defaultActiveAddonKeys: string[]

  // state
  formState: Record<string, unknown>
  formErrors: Record<string, string | null>
  activeAddonKeys: string[]
  slotAttachments: Record<string, ChatAttachment[]>
  isUploading: boolean
  hasErrors: boolean

  // handlers
  handleStateChange: (patch: Record<string, unknown>) => void
  handleFieldError: (fieldKey: string, error: string | null) => void
  handleToggleAddon: (addonKey: string) => void
  handleAddSlotAttachment: (slotKey: string, file: File) => void
  handleRemoveSlotAttachment: (slotKey: string, attachmentId: string) => void

  /**
   * 提交前调用：上传 slotAttachments 里所有附件，返回 URL 合并后的 finalState。
   * 上传失败抛 Error，调用方应 catch 并 toast。
   */
  resolveUploadsAndBuildFinalState: () => Promise<Record<string, unknown>>
}

export function useAskUserFormState(
  fieldDefs: PresetFieldDef[] | undefined,
  addonDefs: AddonParamDef[] | undefined,
): UseAskUserFormStateResult {
  const presetFields = useMemo(
    () => buildGroupedPresetFields(fieldDefs ?? []),
    [fieldDefs],
  )
  const presetAddons = useMemo(
    () => (addonDefs ?? []).map(toPresetAddon),
    [addonDefs],
  )
  const defaultActiveAddonKeys = useMemo(
    () => resolveDefaultActiveAddonKeys(addonDefs),
    [addonDefs],
  )

  const [formState, setFormState] = useState<Record<string, unknown>>(() =>
    buildInitialAskUserFieldState(fieldDefs ?? [], addonDefs),
  )
  const [formErrors, setFormErrors] = useState<Record<string, string | null>>({})
  const [activeAddonKeys, setActiveAddonKeys] = useState<string[]>(defaultActiveAddonKeys)
  const [slotAttachments, setSlotAttachments] = useState<Record<string, ChatAttachment[]>>({})
  const [isUploading, setIsUploading] = useState(false)

  const handleStateChange = useCallback((patch: Record<string, unknown>) => {
    setFormState(prev => ({ ...prev, ...patch }))
  }, [])

  const handleFieldError = useCallback((fieldKey: string, error: string | null) => {
    setFormErrors(prev => ({ ...prev, [fieldKey]: error }))
  }, [])

  const handleToggleAddon = useCallback((addonKey: string) => {
    setActiveAddonKeys(prev => {
      const isActive = prev.includes(addonKey)
      if (isActive) return prev.filter(key => key !== addonKey)
      const addon = presetAddons.find(item => item.key === addonKey)
      setFormState(current => applyAddonDefaults(current, addon))
      return [...prev, addonKey]
    })
  }, [presetAddons])

  const patchSlotAttachment = useCallback((
    slotKey: string,
    attachmentId: string,
    patch: Partial<ChatAttachment>,
  ) => {
    setSlotAttachments((prev) => ({
      ...prev,
      [slotKey]: (prev[slotKey] ?? []).map((att) => (
        att.id === attachmentId ? { ...att, ...patch } : att
      )),
    }))
  }, [])

  const inflightUploadsRef = useRef(0)

  const handleAddSlotAttachment = useCallback((slotKey: string, file: File) => {
    const att = createAttachment(file)
    setSlotAttachments((prev) => ({
      ...prev,
      [slotKey]: [...(prev[slotKey] ?? []), att],
    }))
    // ：添加即上传；提交时只收已 ready 的 URL，不再批量二次上传。
    inflightUploadsRef.current += 1
    setIsUploading(true)
    patchSlotAttachment(slotKey, att.id, { status: 'uploading', uploadProgress: 0 })
    void import('@/services/chatAttachmentApi').then(({ uploadChatAttachment }) =>
      uploadChatAttachment(att),
    ).then((uploaded) => {
      patchSlotAttachment(slotKey, att.id, {
        status: 'ready',
        uploadProgress: 1,
        fileId: uploaded.file_id,
        filename: uploaded.file_name || att.filename,
        mimeType: uploaded.file_type || att.mimeType,
        size: uploaded.file_size || att.size,
        remoteUrl: uploaded.cdn_url || uploaded.access_url,
      })
    }).catch((err) => {
      patchSlotAttachment(slotKey, att.id, {
        status: 'error',
        error: err instanceof Error ? err.message : 'upload failed',
      })
    }).finally(() => {
      inflightUploadsRef.current = Math.max(0, inflightUploadsRef.current - 1)
      setIsUploading(inflightUploadsRef.current > 0)
    })
  }, [patchSlotAttachment])

  const handleRemoveSlotAttachment = useCallback((slotKey: string, attachmentId: string) => {
    setSlotAttachments(prev => ({
      ...prev,
      [slotKey]: (prev[slotKey] ?? []).filter(a => a.id !== attachmentId),
    }))
  }, [])

  const hasErrors = Object.values(formErrors).some(e => e != null)

  const resolveUploadsAndBuildFinalState = useCallback(async (): Promise<Record<string, unknown>> => {
    const finalState = { ...formState }
    const slotResults: Record<string, string[]> = {}
    for (const [slotKey, atts] of Object.entries(slotAttachments)) {
      for (const att of atts) {
        if (att.status === 'uploading' || att.status === 'pending') {
          throw new Error('附件仍在上传，请稍候')
        }
        if (att.status === 'error') {
          throw new Error(att.error || '附件上传失败')
        }
        const url = att.remoteUrl?.trim()
        if (!url) {
          throw new Error('附件尚未就绪')
        }
        if (!slotResults[slotKey]) slotResults[slotKey] = []
        slotResults[slotKey].push(url)
      }
    }
    for (const [slotKey, urls] of Object.entries(slotResults)) {
      finalState[slotKey] = urls.length === 1 ? urls[0] : urls
    }
    return finalState
  }, [formState, slotAttachments])

  return {
    presetFields,
    presetAddons,
    defaultActiveAddonKeys,
    formState,
    formErrors,
    activeAddonKeys,
    slotAttachments,
    isUploading,
    hasErrors,
    handleStateChange,
    handleFieldError,
    handleToggleAddon,
    handleAddSlotAttachment,
    handleRemoveSlotAttachment,
    resolveUploadsAndBuildFinalState,
  }
}
