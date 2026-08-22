import React, { useCallback } from 'react'
import { useViewStore } from '@stores/useViewStore'
import { useTableStore } from '@stores/useTableStore'
import { useFormViewController } from '@tabtin/table-ui'
import type { ViewUpdateRequest } from '@tabtin/table-core'
import { FormEditor } from './form/FormEditor'
import { FormPreviewer } from './form/FormPreviewer'
import type { FormMode } from './form/FormToolBar'

// ---------------------------------------------------------------------------
// FormView — dual-mode container (edit / fill)
// ---------------------------------------------------------------------------

export interface FormViewProps {
  embedded?: boolean
  mode: FormMode
  isReadonly?: boolean
  /** 公开分享场景的 shareId（已知时直接传入，避免 ensureShareId 创建） */
  shareId?: string
  /** 密码保护表单的密码 */
  formPassword?: string
}

export const FormView: React.FC<FormViewProps> = ({ embedded, mode, shareId, formPassword, isReadonly = false }) => {
  const views = useViewStore(s => s.views)
  const currentViewId = useViewStore(s => s.currentViewId)
  const currentViewRecords = useViewStore(s => s.currentViewRecords)
  const fields = useTableStore(s => s.fields)
  const updateView = useViewStore(s => s.updateView)

  const onUpdateView = useCallback(
    async (payload: ViewUpdateRequest) => {
      if (isReadonly) return
      if (!currentViewId) return
      await updateView(currentViewId, payload)
    },
    [currentViewId, isReadonly, updateView],
  )

  const ctrl = useFormViewController({
    views,
    currentViewId,
    currentViewRecords,
    fields,
    onUpdateView,
  })

  if (mode === 'edit' && !isReadonly) {
    return <FormEditor ctrl={ctrl} />
  }

  return <FormPreviewer ctrl={ctrl} shareId={shareId} formPassword={formPassword} />
}

export default FormView
