import React from 'react'
import { useTranslation } from 'react-i18next'
import { RewindPreviewFullPanelShell, type RewindPreviewFullPanelProps } from './RewindPreviewFullPanelShell'

type RewindPreviewFullPanelInput = Omit<RewindPreviewFullPanelProps, 't' | 'i18nLanguage'>

export const RewindPreviewFullPanel: React.FC<RewindPreviewFullPanelInput> = (props) => {
  const { t, i18n } = useTranslation('chat')
  return <RewindPreviewFullPanelShell {...props} t={t} i18nLanguage={i18n.language || 'zh-CN'} />
}

export type { RewindPreviewFullPanelInput as RewindPreviewFullPanelProps }
